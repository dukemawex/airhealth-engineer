import { z } from "zod";
import type { ResolvedLocation } from "../domain";
import { UpstreamError } from "../errors";
import { fetchWithTimeout, readJsonSafe, type FetchLike } from "../http";
import type { Logger } from "../logger";
import { formatPlace } from "../place";
import { pm25Category } from "./aqi";

/**
 * 72-hour air-quality forecast from Copernicus CAMS via Open-Meteo (global, no key).
 * https://open-meteo.com/en/docs/air-quality-api
 * Hours are local wall-clock times at the location ("2026-11-03T14:00").
 */
export interface ForecastHour {
  time: string;
  pm25: number | null;
  pm10: number | null;
  o3: number | null;
  no2: number | null;
  usAqi: number | null;
}

export interface AirForecast {
  location: { name: string; latitude: number; longitude: number };
  timezone: string;
  source: "open-meteo-cams-forecast";
  sourceNote: string;
  fetchedAt: string;
  hours: ForecastHour[];
}

export interface ForecastWindow {
  startLocal: string;
  endLocal: string;
  avgPm25: number | null;
  maxPm25: number | null;
  maxUsAqi: number | null;
  category: string | null;
}

const num = z.array(z.number().nullable()).optional();
const Raw = z.object({
  timezone: z.string().optional(),
  hourly: z.object({ time: z.array(z.string()), pm2_5: num, pm10: num, ozone: num, nitrogen_dioxide: num, us_aqi: num }),
});

export async function fetchForecast(
  loc: ResolvedLocation,
  deps: { fetchImpl: FetchLike; logger: Logger; timeoutMs: number; modelBaseUrl: string; now?: Date },
  hours = 72,
): Promise<AirForecast> {
  const url = new URL(`${deps.modelBaseUrl}/air-quality`);
  url.searchParams.set("latitude", String(loc.latitude));
  url.searchParams.set("longitude", String(loc.longitude));
  url.searchParams.set("hourly", "pm2_5,pm10,ozone,nitrogen_dioxide,us_aqi");
  url.searchParams.set("forecast_days", String(Math.min(5, Math.ceil(hours / 24) + 1)));
  url.searchParams.set("timezone", "auto");
  const res = await fetchWithTimeout(deps.fetchImpl, url, { method: "GET" }, deps.timeoutMs);
  const body = await readJsonSafe(res);
  if (!res.ok) {
    throw new UpstreamError({ service: "open-meteo-forecast", status: res.status, message: `CAMS forecast HTTP ${res.status}`, retryable: res.status >= 500 });
  }
  const data = Raw.parse(body);
  const h = data.hourly;
  const tz = data.timezone ?? loc.timezone ?? "UTC";
  const nowLocal = localHourIso(deps.now ?? new Date(), tz);
  const all: ForecastHour[] = h.time.map((time, i) => ({
    time,
    pm25: round(h.pm2_5?.[i]),
    pm10: round(h.pm10?.[i]),
    o3: round(h.ozone?.[i]),
    no2: round(h.nitrogen_dioxide?.[i]),
    usAqi: round(h.us_aqi?.[i], 0),
  }));
  const startIdx = Math.max(0, all.findIndex((x) => x.time >= nowLocal));
  const out = all.slice(startIdx, startIdx + hours).filter((x) => x.pm25 !== null || x.usAqi !== null);
  deps.logger.info("cams forecast fetched", { hours: out.length, tz });
  return {
    location: { name: loc.name || loc.area ? formatPlace(loc) : `${loc.latitude.toFixed(2)}, ${loc.longitude.toFixed(2)}`, latitude: loc.latitude, longitude: loc.longitude },
    timezone: tz,
    source: "open-meteo-cams-forecast",
    sourceNote: "Copernicus CAMS model forecast via Open-Meteo (~11-40 km grid). A forecast, not a measurement; indicative only.",
    fetchedAt: new Date().toISOString(),
    hours: out,
  };
}

function round(v: number | null | undefined, dp = 1): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** "YYYY-MM-DDTHH:00" for the current hour in a time zone. */
export function localHourIso(d: Date, timeZone: string): string {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
  } catch {
    return d.toISOString().slice(0, 13) + ":00";
  }
}

/** Compact the hourly series into fixed windows (default 6 h) for the planner prompt. */
export function forecastWindows(hours: ForecastHour[], size = 6): ForecastWindow[] {
  const out: ForecastWindow[] = [];
  for (let i = 0; i < hours.length; i += size) {
    const chunk = hours.slice(i, i + size);
    const pm = chunk.map((x) => x.pm25).filter((x): x is number => x !== null);
    const aqi = chunk.map((x) => x.usAqi).filter((x): x is number => x !== null);
    const avg = pm.length ? Math.round((pm.reduce((a, b) => a + b, 0) / pm.length) * 10) / 10 : null;
    const max = pm.length ? Math.max(...pm) : null;
    out.push({
      startLocal: chunk[0]!.time,
      endLocal: nextHour(chunk.at(-1)!.time),
      avgPm25: avg,
      maxPm25: max,
      maxUsAqi: aqi.length ? Math.max(...aqi) : null,
      category: max !== null ? pm25Category(max) : null,
    });
  }
  return out;
}

export function nextHour(localIso: string): string {
  const d = new Date(`${localIso}:00Z`);
  if (Number.isNaN(d.getTime())) return localIso;
  d.setUTCHours(d.getUTCHours() + 1);
  return d.toISOString().slice(0, 16);
}
