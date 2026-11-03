import { NextResponse } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { LocationQuerySchema } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import { formatPlace, geocodeDepsFromConfig, resolveLocation } from "@/lib/services/geocode";

export const runtime = "nodejs";

const Query = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  countryCode: z.string().trim().length(2).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  accuracy: z.coerce.number().min(0).max(1_000_000).optional(),
});

/**
 * Preview how a typed place or shared coordinates resolve, before starting a briefing.
 *   GET /api/geocode?q=Ilorin          GET /api/geocode?q=SW1A%201AA
 *   GET /api/geocode?lat=6.6&lon=3.35&accuracy=40
 */
export const GET = route("geocode", async ({ req, log }) => {
  const sp = req.nextUrl.searchParams;
  const parsed = Query.safeParse(Object.fromEntries([...sp.entries()].filter(([, v]) => v !== "")));
  if (!parsed.success) throw new AppError("bad_request", "Use ?q=<place or postcode> or ?lat=&lon=");
  const { q, countryCode, lat, lon, accuracy } = parsed.data;
  const q2 = LocationQuerySchema.safeParse(
    lat !== undefined && lon !== undefined ? { latitude: lat, longitude: lon, accuracyMeters: accuracy } : { city: q, countryCode },
  );
  if (!q2.success) throw new AppError("bad_request", "Use ?q=<place or postcode> or ?lat=&lon=");
  const query = q2.data;
  const cfg = getConfig();
  const location = await resolveLocation(
    query,
    geocodeDepsFromConfig(cfg.airQuality, { fetchImpl: fetch, logger: log, timeoutMs: 8_000 }),
  );
  return NextResponse.json(
    { location, label: formatPlace(location) },
    { headers: { "cache-control": "private, max-age=300" } },
  );
});
