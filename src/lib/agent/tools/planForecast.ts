import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../errors";
import { applyPhrasing, PLAN_PHRASING_JSON_SCHEMA, PlanPhrasingSchema, phrasingPrompt, rulesPlan, type ForecastPlan } from "../../forecast/plan";
import { DEFAULT_OUTDOOR_MINUTES, locationKey, resolveOutdoorWindow } from "../../forecast/windowMemory";
import { formatPlace } from "../../place";
import { fetchForecast, forecastWindows, type AirForecast } from "../../services/forecast";
import { spaceFromSetting } from "../../space";
import { assessHealth } from "./getHealthContext";
import { defineTool } from "./types";

export const planForecastSchema = z.object({
  horizonHours: z.number().int().min(12).max(72).default(72).describe("How far ahead to plan, hours (max 72)"),
  focus: z.string().trim().max(200).optional().describe("Optional user focus, e.g. 'protect the nursery overnight'"),
  outdoorMinutes: z
    .number()
    .int()
    .min(30)
    .max(240)
    .optional()
    .describe("Only when the user states how long they will be outside (exercise, walk, commute), in minutes. Omit otherwise: the default is 60 min, or the length already on file."),
});

const EFFORTS = ["low", "medium", "high", "max"] as const;
type Effort = (typeof EFFORTS)[number];
/** Plan timeline only: the window itself is computed in code, so low effort is enough. */
export const PLANNER_EFFORT: Effort = (EFFORTS as readonly string[]).includes(process.env.FORECAST_PLANNER_EFFORT ?? "")
  ? (process.env.FORECAST_PLANNER_EFFORT as Effort)
  : "low";
export const PLANNER_TIMEOUT_MS = Math.max(2000, Number(process.env.FORECAST_PLANNER_TIMEOUT_MS) || 12000);
const FORECAST_TTL_S = 60 * 60;
const PLAN_TTL_S = 60 * 60;

const short = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

type Planner =
  | { kind: "muse-spark"; model: string; reasoningEffort: string; ms: number; reasoningTokens: number | null; cached?: boolean }
  | { kind: "rules-fallback"; reason: string; ms: number };

/**
 * 72-hour CAMS forecast for the session location.
 * - The best outdoor window is computed deterministically in code (rolling mean over the
 *   outing length, waking hours, profile threshold) and stored on the session so later
 *   replies quote the same window unless the forecast hour, place, length or threshold change.
 * - The device timeline is computed in code too; Muse Spark (low effort, tiny strict schema,
 *   hard timeout, rules wording as fallback) only phrases it. Forecast and plan are cached per rounded location and hour.
 * Read-only: device steps are proposals the user approves one at a time.
 */
export const planForecastTool = defineTool({
  name: "planForecast",
  description:
    "Fetch the next 72 h of CAMS air-quality forecast for the session's location and build a time-boxed indoor-air control plan (purifier, windows, HVAC). Returns outdoorWindow (the cleanest waking-hours window today/tomorrow for exercise, a walk or a commute, computed in code: quote outdoorWindow.summary verbatim; if outdoorWindowChange is present, say in one short line why it moved) plus forecast and plan steps with proposed device commands. Does NOT run devices. Call it together with getAirQuality (same step) when the user asks about the coming days, tonight, planning ahead, or WHEN to exercise / go outside / commute.",
  schema: planForecastSchema,
  requiresApproval: false,
  timeoutMs: 45_000,
  async execute(args, ctx) {
    const tStart = Date.now();
    const loc = ctx.session.location;
    if (!loc) {
      return {
        needsLocation: true,
        error: "No location on file yet. Call requestLocation (it shows the user a Share-my-location card) and stop; do not ask for a city in text.",
      };
    }
    const locKey = locationKey(loc.latitude, loc.longitude);
    const hourKey = new Date().toISOString().slice(0, 13);
    const fcKey = `fc:v1:${locKey}:${hourKey}:${args.horizonHours}`;
    const cacheGet = async <T>(k: string) => (ctx.store?.getCache ? ctx.store.getCache<T>(k).catch(() => null) : null);
    const cachePut = (k: string, v: unknown, ttl: number) => (ctx.store?.putCache ? ctx.store.putCache(k, v, ttl).catch(() => undefined) : Promise.resolve());

    ctx.progress?.("Reading 72 h forecast…");
    const tFc = Date.now();
    let forecastCache: "hit" | "miss" = "miss";
    const forecastP = (async (): Promise<AirForecast> => {
      const cached = await cacheGet<AirForecast>(fcKey);
      if (cached?.hours?.length) {
        forecastCache = "hit";
        return {
          ...cached,
          location: { name: loc.name || loc.area ? formatPlace(loc) : cached.location.name, latitude: loc.latitude, longitude: loc.longitude },
        };
      }
      const fresh = await fetchForecast(
        loc,
        { fetchImpl: ctx.fetchImpl, logger: ctx.logger, timeoutMs: Math.max(5000, ctx.httpTimeoutMs), modelBaseUrl: ctx.config.airQuality.modelBaseUrl },
        args.horizonHours,
      );
      if (fresh.hours.length) void cachePut(fcKey, fresh, FORECAST_TTL_S);
      return fresh;
    })();
    const devicesP = ctx
      .getDeviceAdapter()
      .getStates(ctx.session.id)
      .then((ds) => ds.map((d) => ({ id: d.deviceId, type: d.deviceType as string })))
      .catch(() => [] as Array<{ id: string; type: string }>);
    const [forecast, devices] = await Promise.all([forecastP, devicesP]);
    const forecastMs = Date.now() - tFc;
    if (!forecast.hours.length) throw new AppError("bad_request", "No forecast hours are available for this location right now.");

    // Deterministic best window, stable within the session.
    ctx.progress?.("Finding your best outdoor window…");
    const p = ctx.session.profile;
    const threshold = p ? assessHealth(p).actionThresholdPm25 : 35.4;
    const durationMinutes = args.outdoorMinutes ?? ctx.session.outdoorWindow?.durationMinutes ?? DEFAULT_OUTDOOR_MINUTES;
    const resolved = resolveOutdoorWindow({
      previous: ctx.session.outdoorWindow,
      hours: forecast.hours.map((h) => ({ t: h.time, pm25: h.pm25 })),
      forecastHour: forecast.hours[0]!.time,
      locationKey: locKey,
      durationMinutes,
      thresholdPm25: threshold,
    });
    ctx.session.outdoorWindow = resolved.stored;
    const outdoorWindow = resolved.window;

    const windows = forecastWindows(forecast.hours);
    const sensitivity = p
      ? [p.ageGroup, ...(p.conditions ?? []), ...(p.symptoms ?? []).map((s) => `symptom: ${s}`), ...(p.household ?? []).map((h) => `household: ${h}`)].filter(Boolean).join(", ") || "general"
      : "general";
    const scene = ctx.session.scene?.analysis;
    const space = spaceFromSetting(scene?.setting);
    const room = scene
      ? `${scene.summary} Windows ${scene.room.windows}, purifier ${scene.room.purifierVisible ? "visible" : "not visible"}, ~${scene.room.estimatedFloorAreaM2 ?? "?"} m²`
      : null;

    // Timeline computed in code (times, risk, device commands); Muse Spark only phrases it
    // (low effort, tiny strict schema, hard timeout). Cached per rounded location and hour.
    const purifierId = devices.find((d) => d.type === "air_purifier")?.id;
    const windowId = devices.find((d) => d.type === "window")?.id;
    const base = rulesPlan(windows, purifierId, windowId, space);
    base.headline = "Timeline computed from the live CAMS forecast.";
    const planKey = `plan:v2:${locKey}:${hourKey}:${short(JSON.stringify([args.horizonHours, sensitivity, purifierId, windowId, room, args.focus ?? "", space ?? "", outdoorWindow?.summary ?? "", base.steps.map((s) => [s.startLocal, s.endLocal, s.risk])]))}`;
    let plan: ForecastPlan = base;
    let planner: Planner;
    const tPlan = Date.now();
    const cachedPlan = await cacheGet<{ plan: ForecastPlan; planner: Planner }>(planKey);
    if (cachedPlan?.plan?.steps?.length) {
      plan = cachedPlan.plan;
      planner = cachedPlan.planner.kind === "muse-spark" ? { ...cachedPlan.planner, cached: true } : cachedPlan.planner;
    } else {
      ctx.progress?.("Phrasing the plan with Muse Spark…");
      try {
        if (!ctx.model) throw new Error("model client unavailable");
        const call = ctx.model.createChatCompletion({
            messages: [
              {
                role: "developer",
                content: phrasingPrompt({ place: forecast.location.name, plan: base, sensitivity, room, focus: args.focus, space, outdoorWindow: outdoorWindow?.summary }),
              },
              { role: "user", content: "Phrase the plan as JSON." },
            ],
            reasoning_effort: PLANNER_EFFORT,
            response_format: { type: "json_schema", json_schema: { name: "plan_phrasing", strict: true, schema: PLAN_PHRASING_JSON_SCHEMA as unknown as Record<string, unknown> } },
          });
        const toPlan = (r: Awaited<typeof call>) => applyPhrasing(base, PlanPhrasingSchema.parse(JSON.parse(r.choices[0]?.message.content ?? "{}")));
        // If phrasing outlives the timeout, still cache it when it lands so the next call is instant.
        call
          .then((r) => cachePut(planKey, { plan: toPlan(r), planner: { kind: "muse-spark", model: r.model, reasoningEffort: PLANNER_EFFORT, ms: Date.now() - tPlan, reasoningTokens: null } }, PLAN_TTL_S))
          .catch(() => undefined);
        const res = await timeout(call, PLANNER_TIMEOUT_MS, "Muse Spark phrasing");
        plan = applyPhrasing(base, PlanPhrasingSchema.parse(JSON.parse(res.choices[0]?.message.content ?? "{}")));
        planner = {
          kind: "muse-spark",
          model: res.model,
          reasoningEffort: PLANNER_EFFORT,
          ms: Date.now() - tPlan,
          reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        };
      } catch (err) {
        ctx.logger.warn("forecast phrasing fell back to rules wording", { error: err });
        planner = { kind: "rules-fallback", reason: err instanceof Error ? err.message.slice(0, 160) : "planner error", ms: Date.now() - tPlan };
      }
    }

    return {
      outdoorWindow,
      ...(resolved.changedFrom
        ? { outdoorWindowChange: { previous: resolved.changedFrom.previous, why: `Window moved because ${resolved.changedFrom.reasons.join(" and ")}.` } }
        : {}),
      outdoorWindowBasis: {
        durationMinutes,
        thresholdPm25: threshold,
        forecastHour: resolved.stored.forecastHour,
        reusedFromSession: resolved.reused,
        method: "lowest rolling-mean PM2.5 over the outing length, 06:00–20:00 local, today first, then the first day under your threshold",
      },
      forecast: {
        location: forecast.location,
        timezone: forecast.timezone,
        sourceNote: forecast.sourceNote,
        fetchedAt: forecast.fetchedAt,
        hours: forecast.hours.map((h) => ({ t: h.time, pm25: h.pm25, aqi: h.usAqi })),
      },
      windows,
      plan,
      planner,
      timing: { totalMs: Date.now() - tStart, forecastMs, forecastCache, plannerMs: Date.now() - tPlan, planCache: cachedPlan?.plan?.steps?.length ? "hit" : "miss" },
      space: space ?? "indoor",
      approvalNote: "Steps are proposals. Each device command runs only after the user approves it via executeDeviceAction.",
    };
  },
});
