import { describe, expect, it, vi } from "vitest";
import { planForecastTool, PLANNER_EFFORT } from "@/lib/agent/tools/planForecast";
import { parseConfig } from "@/lib/config";
import { PLAN_PHRASING_JSON_SCHEMA } from "@/lib/forecast/plan";
import { DEFAULT_OUTDOOR_MINUTES, locationKey, resolveOutdoorWindow } from "@/lib/forecast/windowMemory";
import { buildDeveloperPrompt } from "@/lib/agent/prompt";
import { createLogger } from "@/lib/logger";
import { MemoryStateStore } from "@/lib/storage/memory";
import type { Session } from "@/lib/domain";
import { reply, ScriptedModel } from "./helpers";

const logger = createLogger({ test: true });
const loc = { latitude: 8.4966, longitude: 4.5421, name: "Ilorin", country: "Nigeria", source: "user_coordinates" as const };

function camsBody(n = 96) {
  const start = new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 13) + ":00";
  const t0 = new Date(`${start}:00Z`).getTime();
  const time = Array.from({ length: n }, (_, i) => new Date(t0 + i * 3600_000).toISOString().slice(0, 16));
  const pm = time.map((t) => {
    const h = Number(t.slice(11, 13));
    return h >= 18 || h < 6 ? 30 : h === 10 ? 8 : 15 + (h % 4);
  });
  return { timezone: "UTC", hourly: { time, pm2_5: pm, pm10: pm, ozone: pm, nitrogen_dioxide: pm, us_aqi: pm.map((v) => v * 2) } };
}

function counter() {
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    calls.n++;
    return new Response(JSON.stringify(camsBody()), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const plan = { headline: "Moderate days, smoky nights", steps: [{ id: "step_1", title: "Filter overnight", why: "PM2.5 30" }] };

function makeCtx(opts: { store?: MemoryStateStore; model?: unknown; fetchImpl: typeof fetch; session?: Partial<Session>; progress?: (m: string) => void }) {
  return {
    session: { id: "s1", location: loc, createdAt: "", updatedAt: "", status: "idle", messages: [], ...opts.session } as Session,
    store: opts.store ?? new MemoryStateStore(),
    config: parseConfig({ MODEL_API_KEY: "LLM_test" }),
    fetchImpl: opts.fetchImpl,
    logger,
    httpTimeoutMs: 1000,
    model: opts.model,
    progress: opts.progress,
    getDeviceAdapter: () => ({ name: "sandbox", execute: async () => ({}), getStates: async () => [] }),
  } as never;
}

type Out = {
  outdoorWindow: { startLocal: string; endLocal: string; summary: string } | null;
  outdoorWindowChange?: { previous: string; why: string };
  outdoorWindowBasis: { durationMinutes: number; reusedFromSession: boolean };
  planner: { kind: string; cached?: boolean; reasoningEffort?: string };
  timing: { forecastCache: string; planCache: string; totalMs: number };
};

describe("deterministic best window memory", () => {
  const hours = Array.from({ length: 30 }, (_, i) => {
    const t = new Date(Date.UTC(2026, 10, 3, 6 + i)).toISOString().slice(0, 16);
    const h = Number(t.slice(11, 13));
    return { t, pm25: h === 10 ? 8 : h === 11 ? 20 : h >= 18 || h < 6 ? 30 : 15 };
  });
  const base = { hours, forecastHour: hours[0]!.t, locationKey: "8.50,4.54", durationMinutes: 60, thresholdPm25: 35.4 };

  it("defaults to a 60 minute outing and picks the lowest rolling mean", () => {
    expect(DEFAULT_OUTDOOR_MINUTES).toBe(60);
    const r = resolveOutdoorWindow(base);
    expect(r.window!.startLocal).toBe("2026-11-03T10:00");
    expect(r.window!.endLocal).toBe("2026-11-03T11:00");
    expect(r.reused).toBe(false);
  });

  it("reuses the stored window verbatim for the same hour, place, length and threshold", () => {
    const first = resolveOutdoorWindow(base);
    const tweaked = hours.map((h) => (h.t.endsWith("T07:00") ? { ...h, pm25: 1 } : h));
    const again = resolveOutdoorWindow({ ...base, hours: tweaked, previous: first.stored });
    expect(again.reused).toBe(true);
    expect(again.window!.summary).toBe(first.window!.summary);
    expect(again.changedFrom).toBeUndefined();
  });

  it("explains why when the outing length or threshold moves the window", () => {
    const first = resolveOutdoorWindow(base);
    const longer = resolveOutdoorWindow({ ...base, durationMinutes: 120, previous: first.stored });
    expect(longer.window!.startLocal).not.toBe(first.window!.startLocal);
    expect(longer.changedFrom!.reasons.join(" ")).toMatch(/outing length changed from 1 h to 2 h/);
    const tighter = resolveOutdoorWindow({ ...base, thresholdPm25: 5, previous: first.stored, hours: hours.map((h) => (h.t === "2026-11-04T07:00" ? { ...h, pm25: 4 } : h)) });
    expect(tighter.changedFrom!.reasons.join(" ")).toMatch(/threshold changed from 35.4 to 5/);
  });

  it("stays silent when a new forecast hour keeps the same slot", () => {
    const first = resolveOutdoorWindow(base);
    const next = resolveOutdoorWindow({ ...base, hours: hours.slice(1), forecastHour: hours[1]!.t, previous: first.stored });
    expect(next.window!.summary).toBe(first.window!.summary);
    expect(next.changedFrom).toBeUndefined();
  });

  it("rounds the location key to ~1 km", () => {
    expect(locationKey(8.4966, 4.5421)).toBe("8.50,4.54");
  });
});

describe("planForecast speed path", () => {
  it("uses low effort, a compact schema and streams progress", async () => {
    expect(PLANNER_EFFORT).toBe("low");
    expect(JSON.stringify(PLAN_PHRASING_JSON_SCHEMA)).not.toMatch(/startLocal|deviceId/);
    const { fetchImpl } = counter();
    const progress: string[] = [];
    const model = new ScriptedModel([reply(JSON.stringify(plan))]);
    const out = (await planForecastTool.execute!({ horizonHours: 72 }, makeCtx({ model, fetchImpl, progress: (m) => progress.push(m) }))) as Out;
    expect(progress[0]).toBe("Reading 72 h forecast…");
    expect(progress).toContain("Finding your best outdoor window…");
    expect(progress).toContain("Phrasing the plan with Muse Spark…");
    expect(model.requests[0]!.reasoning_effort).toBe("low");
    expect(String(model.requests[0]!.messages[0]!.content)).toMatch(/Best outdoor window \(computed/);
    expect(out.outdoorWindowBasis.durationMinutes).toBe(60);
    expect(out.planner.kind).toBe("muse-spark");
  });

  it("caches the forecast and plan per rounded location and hour, and keeps the window identical", async () => {
    const store = new MemoryStateStore();
    const { calls, fetchImpl } = counter();
    const model = new ScriptedModel([reply(JSON.stringify(plan))]);
    const a = (await planForecastTool.execute!({ horizonHours: 72 }, makeCtx({ store, model, fetchImpl }))) as Out;
    // A different conversation a few metres away in the same hour.
    const b = (await planForecastTool.execute!(
      { horizonHours: 72 },
      makeCtx({ store, model, fetchImpl, session: { id: "s2", location: { ...loc, latitude: 8.4968 } } }),
    )) as Out;
    expect(calls.n).toBe(1);
    expect(model.requests).toHaveLength(1);
    expect(a.timing.forecastCache).toBe("miss");
    expect(b.timing.forecastCache).toBe("hit");
    expect(b.timing.planCache).toBe("hit");
    expect(b.planner.cached).toBe(true);
    expect(b.outdoorWindow!.summary).toBe(a.outdoorWindow!.summary);
  });

  it("stores the window on the session, reuses it, and keeps the user's earlier length", async () => {
    const { fetchImpl } = counter();
    const c = makeCtx({ fetchImpl }) as unknown as { session: Session };
    const first = (await planForecastTool.execute!({ horizonHours: 72, outdoorMinutes: 90 }, c as never)) as Out;
    expect(c.session.outdoorWindow?.durationMinutes).toBe(90);
    const second = (await planForecastTool.execute!({ horizonHours: 72 }, c as never)) as Out;
    expect(second.outdoorWindowBasis.reusedFromSession).toBe(true);
    expect(second.outdoorWindow!.summary).toBe(first.outdoorWindow!.summary);
    const p = buildDeveloperPrompt(c.session, new Date(), "sandbox");
    expect(p).toContain(first.outdoorWindow!.summary);
    expect(p).toMatch(/quote exactly this line/);
    // Sensitivity tightened afterwards: the prompt flags the stored window as stale.
    c.session.profile = { conditions: [], symptoms: ["wheezing"] } as never;
    expect(buildDeveloperPrompt(c.session, new Date(), "sandbox")).toMatch(/stale: before quoting any window, call planForecast again/);
  });

  it("falls back to the rules plan when Muse Spark is slower than the timeout", async () => {
    vi.resetModules();
    process.env.FORECAST_PLANNER_TIMEOUT_MS = "2000";
    const mod = await import("@/lib/agent/tools/planForecast");
    delete process.env.FORECAST_PLANNER_TIMEOUT_MS;
    const { fetchImpl } = counter();
    const hanging = { createChatCompletion: () => new Promise(() => undefined) };
    const t0 = Date.now();
    const out = (await mod.planForecastTool.execute!({ horizonHours: 72 }, makeCtx({ model: hanging, fetchImpl }))) as Out;
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(out.planner.kind).toBe("rules-fallback");
    expect(out.outdoorWindow).not.toBeNull();
  });
});
