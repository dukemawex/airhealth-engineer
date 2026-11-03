import { describe, expect, it } from "vitest";
import { planForecastTool } from "@/lib/agent/tools/planForecast";
import { parseConfig } from "@/lib/config";
import { normalisePlan, rulesPlan, toDeviceCommand } from "@/lib/forecast/plan";
import { createLogger } from "@/lib/logger";
import { fetchForecast, forecastWindows, nextHour } from "@/lib/services/forecast";
import { applyStepMessage, fmtLocal } from "@/components/cards/ForecastPlanCard";
import { reply, ScriptedModel } from "./helpers";

const logger = createLogger({ test: true });
const loc = { latitude: 6.6, longitude: 3.35, name: "Ikeja", country: "Nigeria", source: "geocoded" as const };

function camsBody(start = new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 13) + ":00", n = 96) {
  const t0 = new Date(`${start}:00Z`).getTime();
  const time = Array.from({ length: n }, (_, i) => new Date(t0 + i * 3600_000).toISOString().slice(0, 16));
  const pm = time.map((_, i) => (i % 24 >= 18 || i % 24 < 3 ? 52 + (i % 3) : 11 + (i % 5)));
  return { timezone: "Africa/Lagos", hourly: { time, pm2_5: pm, pm10: pm.map((v) => v * 1.4), ozone: pm, nitrogen_dioxide: pm, us_aqi: pm.map((v) => v * 2) } };
}
const okFetch = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("CAMS forecast service", () => {
  it("starts at the current local hour and returns 72 hours", async () => {
    const f = await fetchForecast(loc, { fetchImpl: okFetch(camsBody("2026-11-03T00:00")), logger, timeoutMs: 1000, modelBaseUrl: "https://x/v1", now: new Date("2026-11-03T05:30:00Z") });
    expect(f.timezone).toBe("Africa/Lagos");
    expect(f.hours[0]!.time).toBe("2026-11-03T06:00");
    expect(f.hours).toHaveLength(72);
    expect(f.location.name).toContain("Ikeja");
  });

  it("raises an upstream error on HTTP failure", async () => {
    const bad = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchForecast(loc, { fetchImpl: bad, logger, timeoutMs: 1000, modelBaseUrl: "https://x/v1" })).rejects.toThrow(/503/);
  });

  it("compacts hours into 6-hour windows", () => {
    const hours = Array.from({ length: 12 }, (_, i) => ({ time: `2026-11-03T${String(i).padStart(2, "0")}:00`, pm25: i < 6 ? 10 : 40, pm10: null, o3: null, no2: null, usAqi: i }));
    const w = forecastWindows(hours);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ startLocal: "2026-11-03T00:00", endLocal: "2026-11-03T06:00", avgPm25: 10, category: "moderate" });
    expect(w[1]!.maxPm25).toBe(40);
    expect(nextHour("2026-11-03T23:00")).toBe("2026-11-04T00:00");
  });
});

describe("forecast plan normalisation", () => {
  const dev = (o: Partial<{ deviceType: string; deviceId: string; action: string; level: number | null; mode: string | null }>) =>
    ({ deviceType: "air_purifier", deviceId: "fan.p", action: "set_fan_speed", level: 80, mode: null, ...o }) as never;

  it("maps flat device output onto validated DeviceCommands", () => {
    expect(toDeviceCommand(dev({}))).toEqual({ deviceType: "air_purifier", deviceId: "fan.p", action: "set_fan_speed", fanSpeedPercent: 80 });
    expect(toDeviceCommand(dev({ deviceType: "window", deviceId: "cover.w", action: "close", level: null }))).toEqual({ deviceType: "window", deviceId: "cover.w", action: "close" });
    expect(toDeviceCommand(dev({ deviceType: "none", action: "none" }))).toBeNull();
    // An action that does not belong to the device type is dropped, not executed.
    expect(toDeviceCommand(dev({ deviceType: "window", action: "set_fan_speed" }))).toBeNull();
  });

  it("sorts steps and assigns ids", () => {
    const p = normalisePlan({
      headline: " h ",
      steps: [
        { startLocal: "2026-11-03T18:00", endLocal: "2026-11-04T00:00", title: "B", why: "w", risk: "high", device: dev({}) },
        { startLocal: "2026-11-03T06:00", endLocal: "2026-11-03T12:00", title: "A", why: "w", risk: "low", device: dev({ deviceType: "none", action: "none" }) },
      ],
    });
    expect(p.steps.map((s) => [s.id, s.title])).toEqual([["step_1", "A"], ["step_2", "B"]]);
    expect(p.steps[0]!.command).toBeNull();
  });

  it("builds a rules fallback from live windows", () => {
    const p = rulesPlan([
      { startLocal: "a", endLocal: "b", avgPm25: 8, maxPm25: 10, maxUsAqi: 40, category: "moderate" },
      { startLocal: "b", endLocal: "c", avgPm25: 50, maxPm25: 60, maxUsAqi: 150, category: "unhealthy" },
      { startLocal: "c", endLocal: "d", avgPm25: 50, maxPm25: 58, maxUsAqi: 150, category: "unhealthy" },
    ]);
    expect(p.steps).toHaveLength(2);
    expect(p.steps[1]).toMatchObject({ startLocal: "b", endLocal: "d", risk: "very_high" });
    expect(p.steps[1]!.command).toMatchObject({ action: "set_fan_speed", fanSpeedPercent: 100 });
  });

  it("formats local times and the approve-step message", () => {
    expect(fmtLocal("2026-11-03T18:00")).toBe("Tue 18:00");
    const msg = applyStepMessage({ id: "s", startLocal: "2026-11-03T18:00", endLocal: "2026-11-04T06:00", title: "Seal", why: "", risk: "high", command: { deviceType: "window", deviceId: "cover.w", action: "close" } });
    expect(msg).toContain("executeDeviceAction");
    expect(msg).toContain('"deviceId":"cover.w"');
  });
});

describe("planForecast tool", () => {
  const ctx = (model?: ScriptedModel) =>
    ({
      session: { id: "s1", location: loc, profile: { conditions: ["asthma"] }, createdAt: "", updatedAt: "" },
      config: parseConfig({ MODEL_API_KEY: "LLM_test" }),
      fetchImpl: okFetch(camsBody()),
      logger,
      httpTimeoutMs: 1000,
      model,
      getDeviceAdapter: () => ({ name: "sandbox", execute: async () => ({}), getStates: async () => [] }),
    }) as never;

  it("plans with Muse Spark json_schema and never executes devices", async () => {
    const plan = {
      headline: "Two night peaks",
      steps: [{ startLocal: "2026-11-03T18:00", endLocal: "2026-11-04T03:00", title: "Seal and filter", why: "PM2.5 54", risk: "high", device: { deviceType: "air_purifier", deviceId: "fan.bedroom_purifier", action: "set_fan_speed", level: 100, mode: null } }],
    };
    const model = new ScriptedModel([reply(JSON.stringify(plan))]);
    const out = (await planForecastTool.execute!({ horizonHours: 72 }, ctx(model))) as { planner: { kind: string }; plan: { steps: Array<{ command: unknown }> }; forecast: { hours: unknown[] } };
    expect(out.planner.kind).toBe("muse-spark");
    expect(out.plan.steps[0]!.command).toMatchObject({ fanSpeedPercent: 100 });
    expect(out.forecast.hours.length).toBeGreaterThan(0);
    const req = model.requests[0]!;
    expect(req.response_format?.type).toBe("json_schema");
    expect(req.response_format?.json_schema.strict).toBe(true);
    expect(String(req.messages[0]!.content)).toMatch(/never give medical advice/i);
    expect(planForecastTool.requiresApproval).toBe(false);
  });

  it("falls back to a rules plan from live data when the planner fails", async () => {
    const model = new ScriptedModel([reply("not json")]);
    const out = (await planForecastTool.execute!({ horizonHours: 48 }, ctx(model))) as { planner: { kind: string }; plan: { steps: unknown[] } };
    expect(out.planner.kind).toBe("rules-fallback");
    expect(out.plan.steps.length).toBeGreaterThan(0);
  });
});
