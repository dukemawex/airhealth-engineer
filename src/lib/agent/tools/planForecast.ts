import { z } from "zod";
import { AppError } from "../../errors";
import { adaptPlanForSpace, FORECAST_PLAN_JSON_SCHEMA, ForecastPlanSchema, normalisePlan, plannerPrompt, rulesPlan, type ForecastPlan } from "../../forecast/plan";
import { fetchForecast, forecastWindows } from "../../services/forecast";
import { spaceFromSetting } from "../../space";
import { defineTool } from "./types";

export const planForecastSchema = z.object({
  horizonHours: z.number().int().min(12).max(72).default(72).describe("How far ahead to plan, hours (max 72)"),
  focus: z.string().trim().max(200).optional().describe("Optional user focus, e.g. 'protect the nursery overnight'"),
});

const PLANNER_EFFORT = (process.env.FORECAST_PLANNER_EFFORT === "max" ? "max" : process.env.FORECAST_PLANNER_EFFORT === "medium" ? "medium" : "high") as "max" | "high" | "medium";

/**
 * Pull the 72-hour CAMS forecast for the session location and have Muse Spark
 * (reasoning_effort max, strict json_schema) turn it into a time-boxed device
 * plan. Read-only: device steps are proposals the user approves one at a time.
 */
export const planForecastTool = defineTool({
  name: "planForecast",
  description:
    "Fetch the next 72 h of CAMS air-quality forecast for the session's location and build a time-boxed indoor-air control plan (purifier, windows, HVAC). Returns forecast + plan steps with proposed device commands. Does NOT run devices: each step is approved separately via executeDeviceAction. Call after getAirQuality when the user asks about the coming days, tonight, or planning ahead.",
  schema: planForecastSchema,
  requiresApproval: false,
  timeoutMs: 110_000,
  async execute(args, ctx) {
    const loc = ctx.session.location;
    if (!loc) throw new AppError("bad_request", "No location yet: call getAirQuality with the user's place first.");
    const forecast = await fetchForecast(loc, {
      fetchImpl: ctx.fetchImpl,
      logger: ctx.logger,
      timeoutMs: Math.max(5000, ctx.httpTimeoutMs),
      modelBaseUrl: ctx.config.airQuality.modelBaseUrl,
    }, args.horizonHours);
    if (!forecast.hours.length) throw new AppError("bad_request", "No forecast hours are available for this location right now.");
    const windows = forecastWindows(forecast.hours);
    let devices: string[] = [];
    try {
      devices = (await ctx.getDeviceAdapter().getStates(ctx.session.id)).map((d) => `${d.deviceId} (${d.deviceType})`);
    } catch {
      devices = [];
    }
    const p = ctx.session.profile;
    const sensitivity = p
      ? [p.ageGroup, ...(p.conditions ?? []), ...(p.household ?? []).map((h) => `household: ${h}`)].filter(Boolean).join(", ") || "general"
      : "general";
    const scene = ctx.session.scene?.analysis;
    const space = spaceFromSetting(scene?.setting);
    const room = scene
      ? `${scene.summary} Windows ${scene.room.windows}, purifier ${scene.room.purifierVisible ? "visible" : "not visible"}, ~${scene.room.estimatedFloorAreaM2 ?? "?"} m²`
      : null;

    let plan: ForecastPlan;
    let planner: { kind: "muse-spark"; model: string; reasoningEffort: string; ms: number; reasoningTokens: number | null } | { kind: "rules-fallback"; reason: string };
    const t0 = Date.now();
    try {
      if (!ctx.model) throw new Error("model client unavailable");
      const res = await ctx.model.createChatCompletion({
        messages: [
          { role: "developer", content: plannerPrompt({ forecast, windows, sensitivity, devices, room, focus: args.focus, space }) },
          { role: "user", content: "Build the plan as JSON." },
        ],
        reasoning_effort: PLANNER_EFFORT,
        response_format: { type: "json_schema", json_schema: { name: "forecast_plan", strict: true, schema: FORECAST_PLAN_JSON_SCHEMA as unknown as Record<string, unknown> } },
      });
      const raw = ForecastPlanSchema.parse(JSON.parse(res.choices[0]?.message.content ?? "{}"));
      plan = adaptPlanForSpace(normalisePlan(raw), space);
      if (!plan.steps.length) throw new Error("planner returned no steps");
      planner = {
        kind: "muse-spark",
        model: res.model,
        reasoningEffort: PLANNER_EFFORT,
        ms: Date.now() - t0,
        reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      };
    } catch (err) {
      ctx.logger.warn("forecast planner fell back to rules", { error: err });
      plan = rulesPlan(windows, undefined, undefined, space);
      planner = { kind: "rules-fallback", reason: err instanceof Error ? err.message.slice(0, 160) : "planner error" };
    }
    return {
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
      space: space ?? "indoor",
      approvalNote: "Steps are proposals. Each device command runs only after the user approves it via executeDeviceAction.",
    };
  },
});
