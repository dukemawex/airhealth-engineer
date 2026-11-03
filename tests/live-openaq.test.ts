/**
 * Optional live check against the real OpenAQ v3 API. Runs only when
 * OPENAQ_API_KEY is present in the environment; otherwise skipped.
 * LIVE_TEST_CITY can override the place used (test input only).
 */
import { describe, expect, it } from "vitest";
import { createLogger } from "@/lib/logger";
import { fetchAirQuality } from "@/lib/services/airQuality";
import { resolveLocation } from "@/lib/services/geocode";

const key = process.env.OPENAQ_API_KEY;

describe.skipIf(!key)("live OpenAQ (requires OPENAQ_API_KEY)", () => {
  it("geocodes a place and returns real readings or an honest not_found", async () => {
    const logger = createLogger({ test: true });
    const loc = await resolveLocation(
      { city: process.env.LIVE_TEST_CITY ?? "Lagos" },
      { baseUrl: "https://geocoding-api.open-meteo.com/v1", fetchImpl: fetch, logger, timeoutMs: 15_000 },
    );
    try {
      const snap = await fetchAirQuality(loc, 25_000, {
        fetchImpl: fetch,
        logger,
        timeoutMs: 20_000,
        openaqApiKey: key,
        openaqBaseUrl: "https://api.openaq.org/v3",
        modelFallback: false,
        modelBaseUrl: "https://air-quality-api.open-meteo.com/v1",
      });
      expect(snap.source).toBe("openaq");
      expect(snap.readings.length).toBeGreaterThan(0);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("not_found");
    }
  }, 60_000);
});
