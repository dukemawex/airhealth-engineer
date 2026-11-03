import { z } from "zod";
import type { AppConfig } from "../config";
import type { LocationQuery, ResolvedLocation } from "../domain";
import { AppError, UpstreamError } from "../errors";
import { fetchWithTimeout, readJsonSafe, withRetry, type FetchLike } from "../http";
import type { Logger } from "../logger";
import { formatPlace } from "../place";

export { formatPlace };

/**
 * Place resolution, in three directions:
 *
 * 1. Typed place names -> Open-Meteo Geocoding (free, no key), ranked by country hint and population.
 *    Docs: https://open-meteo.com/en/docs/geocoding-api
 * 2. Postcodes, street-level or multi-part queries Open-Meteo can't match -> OpenStreetMap Nominatim search.
 *    Docs: https://nominatim.org/release-docs/latest/api/Search/
 * 3. Shared browser coordinates -> Nominatim reverse geocoding for a readable name, plus the IANA
 *    time zone from the Open-Meteo forecast API (so schedules use local time, not UTC).
 *    Docs: https://nominatim.org/release-docs/latest/api/Reverse/
 *
 * Nominatim's usage policy asks for an identifying User-Agent, at most 1 request/s and caching;
 * results are cached in memory per instance. Naming shared coordinates is best-effort: if both
 * lookups fail the coordinates are still used as-is.
 */

export interface GeocodeDeps {
  /** Open-Meteo geocoding base URL. */
  baseUrl: string;
  nominatimBaseUrl?: string;
  timezoneBaseUrl?: string;
  fetchImpl: FetchLike;
  logger: Logger;
  timeoutMs: number;
}

export const NOMINATIM_USER_AGENT = "AirHealthEngineer/1.0 (+https://github.com/dukemawex/airhealth-engineer)";

export function geocodeDepsFromConfig(
  cfg: AppConfig["airQuality"],
  rest: { fetchImpl: FetchLike; logger: Logger; timeoutMs: number },
): GeocodeDeps {
  return { baseUrl: cfg.geocodingBaseUrl, nominatimBaseUrl: cfg.nominatimBaseUrl, timezoneBaseUrl: cfg.timezoneBaseUrl, ...rest };
}

const OpenMeteoGeo = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
        country_code: z.string().optional(),
        admin1: z.string().optional(),
        admin2: z.string().optional(),
        timezone: z.string().optional(),
        population: z.number().optional(),
        feature_code: z.string().optional(),
      }),
    )
    .optional(),
});
type OpenMeteoHit = NonNullable<z.infer<typeof OpenMeteoGeo>["results"]>[number];

const NominatimAddress = z
  .object({
    neighbourhood: z.string(),
    suburb: z.string(),
    quarter: z.string(),
    city_district: z.string(),
    city: z.string(),
    town: z.string(),
    village: z.string(),
    municipality: z.string(),
    county: z.string(),
    state_district: z.string(),
    state: z.string(),
    region: z.string(),
    postcode: z.string(),
    country: z.string(),
    country_code: z.string(),
  })
  .partial();

const NominatimPlace = z.object({
  lat: z.coerce.number(),
  lon: z.coerce.number(),
  name: z.string().optional(),
  display_name: z.string().optional(),
  address: NominatimAddress.optional(),
});

const TimezoneResponse = z.object({ timezone: z.string().optional() });

/* --------------------------------------------------------------------------------- */
/* Small per-instance cache (geocodes rarely change; keeps us polite to free services) */
/* --------------------------------------------------------------------------------- */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: ResolvedLocation }>();

function cacheGet(key: string): ResolvedLocation | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return { ...hit.value };
}
function cacheSet(key: string, value: ResolvedLocation) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
}
/** Test hook. */
export function clearGeocodeCache() {
  cache.clear();
}

/* -------------------------------------------------------------------------------- */
/* Helpers                                                                           */
/* -------------------------------------------------------------------------------- */

async function getJson(deps: GeocodeDeps, service: string, url: URL, headers: Record<string, string> = {}) {
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(deps.fetchImpl, url, { method: "GET", headers: { Accept: "application/json", ...headers } }, deps.timeoutMs);
      const body = await readJsonSafe(res);
      if (!res.ok) {
        throw new UpstreamError({
          service,
          status: res.status,
          message: `${service} failed with HTTP ${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        });
      }
      return body;
    },
    { maxRetries: 1, label: service, logger: deps.logger, maxRetryAfterMs: 3_000 },
  );
}

/** A query that is probably a postcode or street address rather than a bare place name. */
export function looksLikePostcodeOrAddress(q: string): boolean {
  return /\d/.test(q);
}

const norm = (s: string | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/**
 * Pick the best Open-Meteo hit. Results are already relevance-ordered; we then prefer a
 * country-code match, a match on any qualifier the user typed ("Lagos, Nigeria"), and
 * populated places, so "Lagos" resolves to the city of 15M, not a French village.
 */
export function pickBestPlace(hits: OpenMeteoHit[], opts: { countryCode?: string; qualifiers?: string[] }): OpenMeteoHit | undefined {
  if (hits.length === 0) return undefined;
  const cc = opts.countryCode?.toUpperCase();
  const quals = (opts.qualifiers ?? []).map(norm).filter(Boolean);
  const score = (h: OpenMeteoHit, i: number) => {
    let s = -i * 0.5; // keep upstream relevance as a tie-breaker
    if (cc && h.country_code?.toUpperCase() === cc) s += 100;
    for (const q of quals) {
      if ([h.country, h.admin1, h.admin2, h.country_code].some((f) => f && (norm(f) === q || norm(f).startsWith(q) || q.startsWith(norm(f))))) s += 40;
    }
    if (h.population) s += Math.min(30, Math.log10(h.population + 1) * 4);
    if (h.feature_code?.startsWith("PPLC")) s += 5; // capital
    return s;
  };
  return hits
    .map((h, i) => ({ h, s: score(h, i) }))
    .sort((a, b) => b.s - a.s)[0]!.h;
}

async function searchOpenMeteo(name: string, countryCode: string | undefined, deps: GeocodeDeps): Promise<ResolvedLocation | null> {
  const parts = name
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const attempt = async (q: string, qualifiers: string[]) => {
    const url = new URL(`${deps.baseUrl}/search`);
    url.searchParams.set("name", q);
    url.searchParams.set("count", "10");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");
    if (countryCode) url.searchParams.set("countryCode", countryCode.toUpperCase());
    const data = OpenMeteoGeo.parse(await getJson(deps, "open-meteo-geocoding", url));
    return pickBestPlace(data.results ?? [], { countryCode, qualifiers });
  };
  // Full string first ("Victoria Island, Lagos"), then the first part with the rest as qualifiers.
  let best = await attempt(name, parts.slice(1));
  if (!best && parts.length > 1) best = await attempt(parts[0]!, parts.slice(1));
  if (!best) return null;
  return {
    latitude: best.latitude,
    longitude: best.longitude,
    name: best.name,
    admin1: best.admin1,
    country: best.country,
    countryCode: best.country_code?.toUpperCase(),
    timezone: best.timezone,
    source: "geocoded",
    resolvedBy: "open-meteo",
  };
}

function fromNominatim(p: z.infer<typeof NominatimPlace>): Omit<ResolvedLocation, "source"> {
  const a = p.address ?? {};
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state_district;
  const area = a.suburb ?? a.neighbourhood ?? a.quarter ?? a.city_district;
  return {
    latitude: p.lat,
    longitude: p.lon,
    area: area && area !== city ? area : undefined,
    name: city ?? p.name ?? p.display_name?.split(",")[0]?.trim(),
    admin1: a.state ?? a.region,
    country: a.country,
    countryCode: a.country_code?.toUpperCase(),
    resolvedBy: "nominatim",
  };
}

async function searchNominatim(q: string, countryCode: string | undefined, deps: GeocodeDeps): Promise<ResolvedLocation | null> {
  if (!deps.nominatimBaseUrl) return null;
  const url = new URL(`${deps.nominatimBaseUrl}/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("accept-language", "en");
  if (countryCode) url.searchParams.set("countrycodes", countryCode.toLowerCase());
  const data = z.array(NominatimPlace).parse(await getJson(deps, "nominatim", url, { "User-Agent": NOMINATIM_USER_AGENT }));
  const hit = data[0];
  if (!hit) return null;
  const loc: ResolvedLocation = { ...fromNominatim(hit), source: "geocoded" };
  loc.timezone = await lookupTimezone(loc.latitude, loc.longitude, deps);
  return loc;
}

/** IANA time zone for coordinates (best effort). */
export async function lookupTimezone(latitude: number, longitude: number, deps: GeocodeDeps): Promise<string | undefined> {
  if (!deps.timezoneBaseUrl) return undefined;
  try {
    const url = new URL(`${deps.timezoneBaseUrl}/forecast`);
    url.searchParams.set("latitude", latitude.toFixed(4));
    url.searchParams.set("longitude", longitude.toFixed(4));
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("current", "temperature_2m");
    return TimezoneResponse.parse(await getJson(deps, "open-meteo-timezone", url)).timezone;
  } catch (err) {
    deps.logger.warn("timezone lookup failed", { error: err });
    return undefined;
  }
}

/** Readable name for coordinates (best effort; never throws). */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  deps: GeocodeDeps,
): Promise<Pick<ResolvedLocation, "area" | "name" | "admin1" | "country" | "countryCode" | "resolvedBy">> {
  if (!deps.nominatimBaseUrl) return {};
  try {
    const url = new URL(`${deps.nominatimBaseUrl}/reverse`);
    url.searchParams.set("lat", latitude.toFixed(5));
    url.searchParams.set("lon", longitude.toFixed(5));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "14"); // suburb level: "Oba Akran, Ikeja, Lagos State"
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "en");
    const body = await getJson(deps, "nominatim", url, { "User-Agent": NOMINATIM_USER_AGENT });
    if (body && typeof body === "object" && "error" in body) return {};
    // Reverse responses always echo lat/lon, but don't fail naming if a proxy strips them.
    const withCoords = { lat: latitude, lon: longitude, ...(body as Record<string, unknown>) };
    const { latitude: _la, longitude: _lo, ...named } = fromNominatim(NominatimPlace.parse(withCoords));
    void _la;
    void _lo;
    return { ...named, resolvedBy: "nominatim-reverse" };
  } catch (err) {
    deps.logger.warn("reverse geocoding failed", { error: err });
    return {};
  }
}

/* -------------------------------------------------------------------------------- */
/* Public entry point                                                                */
/* -------------------------------------------------------------------------------- */

export async function resolveLocation(query: LocationQuery, deps: GeocodeDeps): Promise<ResolvedLocation> {
  if (query.latitude !== undefined && query.longitude !== undefined) {
    const lat = Math.round(query.latitude * 1e5) / 1e5;
    const lon = Math.round(query.longitude * 1e5) / 1e5;
    // ~110 m grid for the cache key: nearby fixes share a name.
    const key = `rev:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const cached = cacheGet(key);
    const base: ResolvedLocation = { latitude: lat, longitude: lon, source: "user_coordinates", accuracyMeters: query.accuracyMeters };
    if (cached) return { ...cached, ...base };
    const [named, timezone] = await Promise.all([reverseGeocode(lat, lon, deps), lookupTimezone(lat, lon, deps)]);
    const loc: ResolvedLocation = { ...base, ...named, timezone };
    if (named.name || timezone) cacheSet(key, loc);
    return loc;
  }

  const name = query.city!.trim();
  const cc = query.countryCode?.toUpperCase();
  const key = `fwd:${norm(name)}|${cc ?? ""}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, query: name };

  // Postcodes and addresses go to Nominatim first; bare names to Open-Meteo first.
  const order = looksLikePostcodeOrAddress(name) ? [searchNominatim, searchOpenMeteo] : [searchOpenMeteo, searchNominatim];
  let lastError: unknown;
  for (const search of order) {
    try {
      const hit = await search(name, cc, deps);
      if (hit) {
        cacheSet(key, hit);
        return { ...hit, query: name };
      }
    } catch (err) {
      lastError = err;
      deps.logger.warn("geocoder failed, trying the next one", { error: err, query: name });
    }
  }
  if (lastError) throw lastError;
  throw new AppError(
    "not_found",
    `Could not find "${name}". Try a nearby city or town, add the country (e.g. "${name}, Nigeria"), or share your location.`,
  );
}
