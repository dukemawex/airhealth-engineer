import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeChecks } from "@/lib/agent/tools/designIntervention";
import { assessHealth, mergeProfile } from "@/lib/agent/tools/getHealthContext";
import { toFunctionDefinitions } from "@/lib/agent/tools";
import { ConfigError, parseConfig } from "@/lib/config";
import { toHomeAssistantCall } from "@/lib/devices/homeassistant";
import { signBody } from "@/lib/devices/webhook";
import { InterventionDesignSchema, type Session } from "@/lib/domain";
import { redact } from "@/lib/logger";
import { minimalDesign } from "./helpers";

describe("config", () => {
  it("defaults to muse-spark-1.3 on api.meta.ai and sandbox devices", () => {
    const c = parseConfig({});
    expect(c.meta.modelId).toBe("muse-spark-1.3");
    expect(c.meta.baseUrl).toBe("https://api.meta.ai/v1");
    expect(c.devices.adapter).toBe("sandbox");
    expect(c.storage.redisUrl).toBeUndefined();
  });
  it("rejects non-Muse-Spark model ids", () => {
    expect(() => parseConfig({ META_MODEL_ID: "gpt-4o" })).toThrow(ConfigError);
  });
  it("accepts Vercel KV credential names", () => {
    const c = parseConfig({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" });
    expect(c.storage.redisUrl).toBe("https://x.upstash.io");
  });
});

describe("health assessment", () => {
  it("flags sensitive groups and red flags", () => {
    const a = assessHealth({
      conditions: ["Asthma"],
      symptoms: ["chest pain"],
      recentData: { spo2Percent: 90, peakFlowLpm: 200, personalBestPeakFlowLpm: 500 },
    });
    expect(a.sensitiveGroup).toBe(true);
    expect(a.urgentCareAdvised).toBe(true);
    expect(a.redFlags).toHaveLength(3);
    expect(a.actionThresholdPm25).toBe(9);
  });
  it("merges profiles without duplicates", () => {
    const m = mergeProfile({ conditions: ["asthma"], symptoms: [] }, { conditions: ["Asthma", "COPD"], symptoms: ["cough"] }, false);
    expect(m.conditions).toHaveLength(2);
    expect(m.symptoms).toEqual(["cough"]);
  });
});

describe("engineering checks", () => {
  it("sizes CADR and flags open windows in poor air", () => {
    const design = InterventionDesignSchema.parse({
      ...minimalDesign,
      ventilation: {
        strategy: "natural_when_clean",
        schedule: [{ start: "07:00", end: "08:00", mode: "windows_open", rationale: "morning airing" }],
      },
    });
    const session = {
      id: "ses_x",
      profile: { conditions: ["asthma"], symptoms: [] },
      lastAirQuality: {
        location: { latitude: 0, longitude: 0, source: "user_coordinates" },
        source: "openaq",
        sourceNote: "",
        fetchedAt: new Date().toISOString(),
        readings: [{ parameter: "pm25", value: 60, units: "µg/m³" }],
      },
    } as unknown as Session;
    const checks = computeChecks(design, session);
    expect(checks.roomVolumeM3).toBe(30);
    expect(checks.targetAirChangesPerHour).toBe(5);
    expect(checks.requiredCadrM3h).toBe(150);
    expect(checks.requiredCadrCfm).toBe(88);
    expect(checks.outdoorPm25Category).toBe("unhealthy");
    expect(checks.warnings.some((w) => w.includes("opens windows"))).toBe(true);
  });
});

describe("tool schemas and adapters", () => {
  it("exports JSON-schema function definitions", () => {
    const defs = toFunctionDefinitions();
    for (const d of defs) {
      expect(d.type).toBe("function");
      expect(d.function.parameters).toHaveProperty("type");
      expect(d.function.parameters).not.toHaveProperty("$schema");
    }
  });
  it("maps commands to Home Assistant services", () => {
    expect(toHomeAssistantCall({ deviceType: "air_purifier", deviceId: "fan.p", action: "set_fan_speed", fanSpeedPercent: 60 })).toEqual({
      domain: "fan",
      service: "set_percentage",
      data: { entity_id: "fan.p", percentage: 60 },
    });
    expect(toHomeAssistantCall({ deviceType: "window", deviceId: "cover.w", action: "close" }).service).toBe("close_cover");
    expect(toHomeAssistantCall({ deviceType: "hvac", deviceId: "climate.h", action: "set_mode", mode: "fan_only" }).data).toEqual({
      entity_id: "climate.h",
      hvac_mode: "fan_only",
    });
  });
  it("signs webhook bodies with HMAC-SHA256", () => {
    const expected = createHmac("sha256", "secret").update("{}").digest("hex");
    expect(signBody("secret", "{}")).toBe(`sha256=${expected}`);
    expect(signBody("secret", "{}")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
  it("redacts secrets in logs", () => {
    expect(redact({ apiKey: "LLM_x", nested: { Authorization: "Bearer y" }, ok: 1 })).toEqual({
      apiKey: "[redacted]",
      nested: { Authorization: "[redacted]" },
      ok: 1,
    });
  });
});
