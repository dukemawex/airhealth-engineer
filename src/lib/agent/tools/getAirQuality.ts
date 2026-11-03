import { z } from "zod";
import { LocationQuerySchema } from "../../domain";
import { fetchAirQuality } from "../../services/airQuality";
import { resolveLocation } from "../../services/geocode";
import { recordAirQuality } from "../sessionState";
import { defineTool } from "./types";

export const getAirQualitySchema = z
  .object({
    latitude: z.number().min(-90).max(90).optional().describe("WGS84 latitude"),
    longitude: z.number().min(-180).max(180).optional().describe("WGS84 longitude"),
    city: z.string().trim().min(1).max(120).optional().describe("City or place name anywhere in the world"),
    countryCode: z.string().trim().length(2).optional().describe("Optional ISO 3166-1 alpha-2 code to disambiguate city"),
    radiusMeters: z.number().int().min(1000).max(25000).default(15000).describe("Station search radius (max 25 km)"),
  })
  .describe("Provide latitude+longitude, or a city (optionally with countryCode). Omit all to reuse the session location.");

export const getAirQualityTool = defineTool({
  name: "getAirQuality",
  description:
    "Get current outdoor air quality (PM2.5, PM10, NO2, O3, SO2, CO) for any location worldwide. Uses measured OpenAQ station data; falls back to clearly-labelled modelled data only where no station is in range. Accepts coordinates or a city name. Call this before designing any intervention.",
  schema: getAirQualitySchema,
  requiresApproval: false,
  async execute(args, ctx) {
    const { radiusMeters, ...rest } = args;
    const hasQuery = rest.city !== undefined || (rest.latitude !== undefined && rest.longitude !== undefined);
    let location = ctx.session.location;
    if (hasQuery) {
      const query = LocationQuerySchema.parse(rest);
      location = await resolveLocation(query, {
        baseUrl: ctx.config.airQuality.geocodingBaseUrl,
        fetchImpl: ctx.fetchImpl,
        logger: ctx.logger,
        timeoutMs: ctx.httpTimeoutMs,
      });
    }
    if (!location) {
      return { error: "No location known for this session. Ask the user for a city or coordinates." };
    }
    const snapshot = await fetchAirQuality(location, radiusMeters, {
      fetchImpl: ctx.fetchImpl,
      logger: ctx.logger,
      timeoutMs: ctx.httpTimeoutMs,
      openaqApiKey: ctx.config.airQuality.openaqApiKey,
      openaqBaseUrl: ctx.config.airQuality.openaqBaseUrl,
      modelFallback: ctx.config.airQuality.modelFallback,
      modelBaseUrl: ctx.config.airQuality.modelBaseUrl,
    });
    recordAirQuality(ctx.session, snapshot);
    await ctx.store.addMonitoredSession(ctx.session.id).catch(() => undefined);
    return snapshot;
  },
});
