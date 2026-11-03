import { z } from "zod";
import type { AirQualitySnapshot, PollutantReading, ResolvedLocation } from "../domain";
import { AppError, UpstreamError } from "../errors";
import { fetchWithTimeout, parseRetryAfter, readJsonSafe, withRetry, type FetchLike } from "../http";
import type { Logger } from "../logger";
import { nowIso } from "../ids";
import { haversineKm, pm25Category } from "./aqi";

/**
 * Air quality from OpenAQ v3 (measured, station-based), with an optional
 * Open-Meteo / CAMS modelled fallback where no station is in range.
 *
 * OpenAQ v3 (X-API-Key header):
 *   GET /v3/locations?coordinates={lat},{lon}&radius={m<=25000}&limit=N
 *   GET /v3/locations/{id}/latest
 *   Docs: https://docs.openaq.org/using-the-api/geospatial
 *         https://docs.openaq.org/api/operations/location_latest_get_v3_locations__locations_id__latest_get
 * Open-Meteo Air Quality (no key): GET /v1/air-quality?latitude&longitude&current=...
 *   Docs: https://open-meteo.com/en/docs/air-quality-api
 */

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_STATIONS = 3;

const OpenAqLocations = z.object({
  results: z.array(
    z.object({
      id: z.number(),
      name: z.string().nullable().optional(),
      locality: z.string().nullable().optional(),
      timezone: z.string().optional(),
      country: z.object({ code: z.string().optional(), name: z.string().optional() }).partial().optional(),
      coordinates: z.object({ latitude: z.number().nullable(), longitude: z.number().nullable() }),
      sensors: z
        .array(
          z.object({
            id: z.number(),
            parameter: z.object({ name: z.string(), units: z.string(), displayName: z.string().nullable().optional() }),
          }),
        )
        .default([]),
      datetimeLast: z.object({ utc: z.string() }).nullable().optional(),
    }),
  ),
});

const OpenAqLatest = z.object({
  results: z.array(
    z.object({
      datetime: z.object({ utc: z.string(), local: z.string().optional() }),
      value: z.number(),
      sensorsId: z.number(),
      locationsId: z.number(),
    }),
  ),
});

const OpenMeteoAq = z.object({
  current: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
  current_units: z.record(z.string(), z.string()).optional(),
  timezone: z.string().optional(),
});

export interface AirQualityDeps {
  fetchImpl: FetchLike;
  logger: Logger;
  timeoutMs: number;
  openaqApiKey?: string;
  openaqBaseUrl: string;
  modelFallback: boolean;
  modelBaseUrl: string;
}

async function getJson(
  deps: AirQualityDeps,
  service: string,
  url: URL,
  headers: Record<string, string>,
): Promise<unknown> {
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(deps.fetchImpl, url, { method: "GET", headers }, deps.timeoutMs);
      const body = await readJsonSafe(res);
      if (!res.ok) {
        throw new UpstreamError({
          service,
          status: res.status,
          message: `${service} HTTP ${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
          body,
        });
      }
      return body;
    },
    { maxRetries: 2, label: service, logger: deps.logger, maxRetryAfterMs: 5_000 },
  );
}

/** Normalise OpenAQ parameter names to short keys (pm25, pm10, no2, o3, so2, co). */
function normaliseParam(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^pm2(\d)$/, "pm2$1");
}

async function fromOpenAq(
  loc: ResolvedLocation,
  radiusMeters: number,
  deps: AirQualityDeps,
): Promise<AirQualitySnapshot | null> {
  if (!deps.openaqApiKey) return null;
  const headers = { "X-API-Key": deps.openaqApiKey, Accept: "application/json" };
  const url = new URL(`${deps.openaqBaseUrl}/locations`);
  url.searchParams.set("coordinates", `${loc.latitude.toFixed(4)},${loc.longitude.toFixed(4)}`);
  url.searchParams.set("radius", String(radiusMeters));
  url.searchParams.set("limit", "50");
  const locations = OpenAqLocations.parse(await getJson(deps, "openaq", url, headers)).results;

  const ranked = locations
    .filter((l) => l.coordinates.latitude !== null && l.coordinates.longitude !== null)
    .map((l) => ({
      ...l,
      distanceKm: haversineKm(loc.latitude, loc.longitude, l.coordinates.latitude!, l.coordinates.longitude!),
      lastMs: l.datetimeLast ? Date.parse(l.datetimeLast.utc) : 0,
    }))
    // Prefer stations that reported in the last 7 days, then nearest first.
    .sort((a, b) => {
      const recentA = Date.now() - a.lastMs < 7 * 86_400_000 ? 0 : 1;
      const recentB = Date.now() - b.lastMs < 7 * 86_400_000 ? 0 : 1;
      return recentA - recentB || a.distanceKm - b.distanceKm;
    })
    .slice(0, MAX_STATIONS);

  if (ranked.length === 0) return null;

  const best = new Map<string, PollutantReading>();
  for (const station of ranked) {
    const latestUrl = new URL(`${deps.openaqBaseUrl}/locations/${station.id}/latest`);
    let latest: z.infer<typeof OpenAqLatest>["results"];
    try {
      latest = OpenAqLatest.parse(await getJson(deps, "openaq", latestUrl, headers)).results;
    } catch (err) {
      deps.logger.warn("openaq latest fetch failed for station", { stationId: station.id, error: err });
      continue;
    }
    const sensorParam = new Map(station.sensors.map((s) => [s.id, s.parameter]));
    for (const m of latest) {
      const p = sensorParam.get(m.sensorsId);
      if (!p || !Number.isFinite(m.value) || m.value < 0) continue;
      const key = normaliseParam(p.name);
      const observedMs = Date.parse(m.datetime.utc);
      const reading: PollutantReading = {
        parameter: key,
        value: m.value,
        units: p.units,
        observedAt: m.datetime.utc,
        stationName: station.name ?? station.locality ?? `OpenAQ location ${station.id}`,
        distanceKm: Math.round(station.distanceKm * 10) / 10,
        stale: Number.isFinite(observedMs) ? Date.now() - observedMs > STALE_AFTER_MS : true,
      };
      const existing = best.get(key);
      // Keep the freshest non-stale reading; ties broken by distance (stations are already sorted).
      if (!existing || (existing.stale && !reading.stale)) best.set(key, reading);
    }
  }
  if (best.size === 0) return null;

  const readings = [...best.values()];
  const pm25 = readings.find((r) => r.parameter === "pm25" && !r.stale);
  const first = ranked[0]!;
  return {
    location: {
      ...loc,
      timezone: loc.timezone ?? first.timezone,
      countryCode: loc.countryCode ?? first.country?.code,
    },
    source: "openaq",
    sourceNote:
      "Measured values from the nearest OpenAQ reference/low-cost stations. PM2.5 category uses US EPA (2024) breakpoints applied to the latest reading (indicative; official AQI uses 24-h averages).",
    fetchedAt: nowIso(),
    readings,
    pm25Category: pm25 ? pm25Category(pm25.value) : undefined,
    stationsConsidered: ranked.length,
  };
}

const OPEN_METEO_VARS: Record<string, string> = {
  pm2_5: "pm25",
  pm10: "pm10",
  nitrogen_dioxide: "no2",
  ozone: "o3",
  sulphur_dioxide: "so2",
  carbon_monoxide: "co",
};

async function fromModel(loc: ResolvedLocation, deps: AirQualityDeps): Promise<AirQualitySnapshot | null> {
  const url = new URL(`${deps.modelBaseUrl}/air-quality`);
  url.searchParams.set("latitude", String(loc.latitude));
  url.searchParams.set("longitude", String(loc.longitude));
  url.searchParams.set("current", [...Object.keys(OPEN_METEO_VARS), "us_aqi"].join(","));
  url.searchParams.set("timezone", "auto");
  const data = OpenMeteoAq.parse(await getJson(deps, "open-meteo-air-quality", url, {}));
  if (!data.current) return null;
  const observedAt = typeof data.current.time === "string" ? data.current.time : undefined;
  const readings: PollutantReading[] = [];
  for (const [src, key] of Object.entries(OPEN_METEO_VARS)) {
    const v = data.current[src];
    if (typeof v === "number") {
      readings.push({ parameter: key, value: v, units: data.current_units?.[src] ?? "µg/m³", observedAt });
    }
  }
  if (readings.length === 0) return null;
  const pm25 = readings.find((r) => r.parameter === "pm25");
  return {
    location: { ...loc, timezone: loc.timezone ?? data.timezone },
    source: "open-meteo-cams-model",
    sourceNote:
      "No OpenAQ station data available within range, so these are MODELLED values (Copernicus CAMS via Open-Meteo, ~11-40 km grid), not measurements. Treat as indicative.",
    fetchedAt: nowIso(),
    readings,
    pm25Category: pm25 ? pm25Category(pm25.value) : undefined,
  };
}

export async function fetchAirQuality(
  loc: ResolvedLocation,
  radiusMeters: number,
  deps: AirQualityDeps,
): Promise<AirQualitySnapshot> {
  let openAqError: unknown;
  try {
    const snap = await fromOpenAq(loc, radiusMeters, deps);
    if (snap) return snap;
  } catch (err) {
    openAqError = err;
    deps.logger.warn("openaq lookup failed", { error: err });
  }
  if (deps.modelFallback) {
    const snap = await fromModel(loc, deps);
    if (snap) {
      if (!deps.openaqApiKey) snap.sourceNote += " (OPENAQ_API_KEY is not configured.)";
      return snap;
    }
  }
  if (!deps.openaqApiKey) {
    throw new AppError("config_missing", "OPENAQ_API_KEY is not set and the modelled fallback is disabled.");
  }
  if (openAqError) throw openAqError;
  throw new AppError(
    "not_found",
    `No air-quality stations reported data within ${Math.round(radiusMeters / 1000)} km of ${loc.latitude},${loc.longitude}.`,
  );
}
