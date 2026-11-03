import { z } from "zod";
import type { LocationQuery, ResolvedLocation } from "../domain";
import { AppError, UpstreamError } from "../errors";
import { fetchWithTimeout, readJsonSafe, withRetry, type FetchLike } from "../http";
import type { Logger } from "../logger";

/**
 * Open-Meteo Geocoding API (free, no key): GET {base}/search?name=...&count=...
 * Docs: https://open-meteo.com/en/docs/geocoding-api
 */
const GeoResponse = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
        country_code: z.string().optional(),
        admin1: z.string().optional(),
        timezone: z.string().optional(),
        population: z.number().optional(),
      }),
    )
    .optional(),
});

export async function resolveLocation(
  query: LocationQuery,
  deps: { baseUrl: string; fetchImpl: FetchLike; logger: Logger; timeoutMs: number },
): Promise<ResolvedLocation> {
  if (query.latitude !== undefined && query.longitude !== undefined) {
    return { latitude: query.latitude, longitude: query.longitude, source: "user_coordinates" };
  }
  const name = query.city!;
  const url = new URL(`${deps.baseUrl}/search`);
  url.searchParams.set("name", name);
  url.searchParams.set("count", "5");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  if (query.countryCode) url.searchParams.set("countryCode", query.countryCode.toUpperCase());

  const data = await withRetry(
    async () => {
      const res = await fetchWithTimeout(deps.fetchImpl, url, { method: "GET" }, deps.timeoutMs);
      const body = await readJsonSafe(res);
      if (!res.ok) {
        throw new UpstreamError({
          service: "open-meteo-geocoding",
          status: res.status,
          message: `Geocoding failed with HTTP ${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        });
      }
      return GeoResponse.parse(body);
    },
    { maxRetries: 2, label: "geocode", logger: deps.logger },
  );

  const best = data.results?.[0];
  if (!best) {
    throw new AppError("not_found", `Could not geocode "${name}". Try adding a country code or use coordinates.`);
  }
  return {
    latitude: best.latitude,
    longitude: best.longitude,
    name: best.name,
    admin1: best.admin1,
    country: best.country,
    countryCode: best.country_code,
    timezone: best.timezone,
    source: "geocoded",
  };
}
