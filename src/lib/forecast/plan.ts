import { z } from "zod";
import { DeviceCommandSchema, type DeviceCommand } from "../domain";
import type { AirForecast, ForecastWindow } from "../services/forecast";
import { INDOOR_ONLY_DEVICES, isOpenSpace, SPACE_LABEL, type SpaceType } from "../space";

/**
 * A 72-hour indoor-air control plan: time-boxed steps that each may carry ONE device
 * command. Plan steps are proposals only; every device command still goes through
 * executeDeviceAction and its human approval gate.
 */
export const RISK_LEVELS = ["low", "moderate", "high", "very_high"] as const;
const DEVICE_TYPES = ["none", "air_purifier", "hvac", "window"] as const;
const ACTIONS = [
  "none",
  "turn_on",
  "turn_off",
  "set_fan_speed",
  "set_mode",
  "open",
  "close",
  "set_position",
  "set_fan_mode",
  "set_fresh_air_intake",
] as const;

export const PlanStepSchema = z.object({
  startLocal: z.string().max(20),
  endLocal: z.string().max(20),
  title: z.string().max(90),
  why: z.string().max(280),
  risk: z.enum(RISK_LEVELS),
  device: z.object({
    deviceType: z.enum(DEVICE_TYPES),
    deviceId: z.string().max(120),
    action: z.enum(ACTIONS),
    level: z.number().nullable(),
    mode: z.string().max(20).nullable(),
  }),
});
export const ForecastPlanSchema = z.object({
  headline: z.string().max(200),
  steps: z.array(PlanStepSchema).max(10),
});
export type RawForecastPlan = z.infer<typeof ForecastPlanSchema>;

const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
export const FORECAST_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "steps"],
  properties: {
    headline: str("One sentence: what the next 72 hours look like and the overall control strategy."),
    steps: {
      type: "array",
      description: "3-5 chronological steps covering the forecast; merge quiet periods.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["startLocal", "endLocal", "title", "why", "risk", "device"],
        properties: {
          startLocal: str("Local time YYYY-MM-DDTHH:00 copied from the forecast windows."),
          endLocal: str("Local time YYYY-MM-DDTHH:00."),
          title: str("Short imperative, e.g. 'Seal the bedroom and run the purifier high'."),
          why: str("One short clause (max 120 characters) citing the forecast numbers."),
          risk: { type: "string", enum: [...RISK_LEVELS] },
          device: {
            type: "object",
            additionalProperties: false,
            required: ["deviceType", "deviceId", "action", "level", "mode"],
            properties: {
              deviceType: { type: "string", enum: [...DEVICE_TYPES], description: "'none' for a behaviour-only step." },
              deviceId: str("Entity id, e.g. fan.bedroom_purifier, climate.living_room, cover.bedroom_window; empty for none."),
              action: { type: "string", enum: [...ACTIONS] },
              level: { type: ["number", "null"], description: "Fan speed %, window position % or fresh-air %, else null." },
              mode: { type: ["string", "null"], description: "Purifier mode (auto|sleep|turbo|manual) or HVAC mode, else null." },
            },
          },
        },
      },
    },
  },
} as const;

export interface PlanStep {
  id: string;
  startLocal: string;
  endLocal: string;
  title: string;
  why: string;
  risk: (typeof RISK_LEVELS)[number];
  command: DeviceCommand | null;
}

export interface ForecastPlan {
  headline: string;
  steps: PlanStep[];
}

/** Turn the flat model output into validated DeviceCommands; drop anything invalid. */
export function toDeviceCommand(d: RawForecastPlan["steps"][number]["device"]): DeviceCommand | null {
  if (d.deviceType === "none" || d.action === "none" || !d.deviceId.trim()) return null;
  const level = d.level === null ? undefined : Math.round(Math.max(0, Math.min(100, d.level)));
  const base: Record<string, unknown> = { deviceType: d.deviceType, deviceId: d.deviceId.trim(), action: d.action };
  if (d.deviceType === "air_purifier") {
    if (d.action === "set_fan_speed") base.fanSpeedPercent = level;
    if (d.action === "set_mode") base.mode = d.mode ?? undefined;
  } else if (d.deviceType === "window") {
    if (d.action === "set_position") base.positionPercent = level;
  } else if (d.deviceType === "hvac") {
    if (d.action === "set_mode") base.mode = d.mode ?? undefined;
    if (d.action === "set_fan_mode") base.fanMode = d.mode ?? undefined;
    if (d.action === "set_fresh_air_intake") base.freshAirPercent = level;
  }
  const parsed = DeviceCommandSchema.safeParse(base);
  return parsed.success ? parsed.data : null;
}

export function normalisePlan(raw: RawForecastPlan): ForecastPlan {
  const steps = raw.steps
    .filter((s) => s.title.trim())
    .sort((a, b) => a.startLocal.localeCompare(b.startLocal))
    .slice(0, 8)
    .map((s, i) => ({
      id: `step_${i + 1}`,
      startLocal: s.startLocal,
      endLocal: s.endLocal,
      title: s.title.trim(),
      why: s.why.trim(),
      risk: s.risk,
      command: toDeviceCommand(s.device),
    }));
  return { headline: raw.headline.trim(), steps };
}

export function plannerPrompt(input: {
  forecast: AirForecast;
  windows: ForecastWindow[];
  sensitivity: string;
  devices: string[];
  room: string | null;
  focus?: string;
  space?: SpaceType;
  /** Deterministic best outdoor window (already computed in code); the plan must not contradict it. */
  outdoorWindow?: string | null;
}): string {
  return [
    "You are the planning module of AirHealth Engineer, an agent that engineers indoor air by controlling purifiers, HVAC and windows to reduce exposure.",
    "You never give medical advice, diagnoses or medication guidance; you plan ENVIRONMENT and DEVICE control only.",
    `Location: ${input.forecast.location.name} (local time zone ${input.forecast.timezone}).`,
    `Sensitivity profile: ${input.sensitivity}.`,
    input.room ? `Room (from the user's latest photo): ${input.room}.` : "No room photo yet.",
    `Known devices: ${input.devices.length ? input.devices.join(", ") : "none registered yet; use conventional ids like fan.bedroom_purifier, cover.bedroom_window, climate.living_room"}.`,
    input.focus ? `User focus: ${input.focus}.` : "",
    isOpenSpace(input.space)
      ? `Space: ${SPACE_LABEL[input.space!]}. There are no windows, HVAC or room to filter: use deviceType 'none' and plan exposure timing, staying upwind of smoke, moving away from the source and reducing burning during the worst hours.`
      : "",
    "CAMS forecast in 6-hour windows (PM2.5 µg/m³, US AQI):",
    JSON.stringify(input.windows),
    input.outdoorWindow
      ? `Best outdoor window (computed from the hourly series; do NOT change it): ${input.outdoorWindow}. Any exercise/outdoor/ventilation advice must use exactly this window.`
      : "",
    "Be brief. Write 3-5 chronological steps that cover the forecast. Pre-empt peaks (start filtration 1-2 h before), open windows only in the cleanest windows, and keep purifier noise low overnight unless air is bad.",
    "Each step's 'why' must cite the forecast numbers. Use deviceType 'none' for behaviour-only steps (e.g. postpone outdoor exercise).",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Strip indoor-only device commands from a plan for an open-sided or outdoor space. */
export function adaptPlanForSpace(plan: ForecastPlan, space: SpaceType | undefined): ForecastPlan {
  if (!isOpenSpace(space)) return plan;
  const indoor = new Set<string>(INDOOR_ONLY_DEVICES);
  return { ...plan, steps: plan.steps.map((s) => (s.command && indoor.has(s.command.deviceType) ? { ...s, command: null } : s)) };
}

/** Deterministic plan from live forecast numbers, used only when Muse Spark planning is unavailable. */
export function rulesPlan(
  windows: ForecastWindow[],
  purifierId = "fan.bedroom_purifier",
  windowId = "cover.bedroom_window",
  space?: SpaceType,
): ForecastPlan {
  const open = isOpenSpace(space);
  const risk = (pm: number | null): PlanStep["risk"] => (pm === null ? "low" : pm > 55.4 ? "very_high" : pm > 35.4 ? "high" : pm > 12 ? "moderate" : "low");
  const merged: Array<{ start: string; end: string; risk: PlanStep["risk"]; max: number | null }> = [];
  for (const w of windows) {
    const r = risk(w.maxPm25);
    const last = merged.at(-1);
    if (last && last.risk === r) {
      last.end = w.endLocal;
      last.max = Math.max(last.max ?? 0, w.maxPm25 ?? 0);
    } else merged.push({ start: w.startLocal, end: w.endLocal, risk: r, max: w.maxPm25 });
  }
  const steps = merged.slice(0, 8).map((m, i): PlanStep => {
    const bad = m.risk === "high" || m.risk === "very_high";
    const command: DeviceCommand | null = open
      ? null
      : bad
      ? { deviceType: "air_purifier", deviceId: purifierId, action: "set_fan_speed", fanSpeedPercent: m.risk === "very_high" ? 100 : 70 }
      : m.risk === "low"
        ? { deviceType: "window", deviceId: windowId, action: "open" }
        : { deviceType: "air_purifier", deviceId: purifierId, action: "set_mode", mode: "auto" };
    return {
      id: `step_${i + 1}`,
      startLocal: m.start,
      endLocal: m.end,
      title: open
        ? bad
          ? "Cut time here, stay upwind of smoke"
          : m.risk === "low"
            ? "Cleanest hours: do the smoky work now"
            : "Stay upwind of any smoke source"
        : bad
          ? "Keep windows shut and filter hard"
          : m.risk === "low"
            ? "Ventilate while the air is clean"
            : "Purifier on auto, windows mostly closed",
      why: `Forecast peak PM2.5 ${m.max ?? "n/a"} µg/m³ in this period.`,
      risk: m.risk,
      command,
    };
  });
  return { headline: "Rule-based plan from the live CAMS forecast (Muse Spark planner unavailable).", steps };
}

/**
 * Speed path: the timeline (times, risk, device commands) is computed in code by rulesPlan,
 * and Muse Spark only rewrites the wording. The output is tiny, so it returns in seconds.
 */
export const PLAN_PHRASING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "steps"],
  properties: {
    headline: { type: "string", description: "One sentence, max 110 characters, about the next 72 h for this person." },
    steps: {
      type: "array",
      description: "One entry per given step id, same order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "why"],
        properties: {
          id: { type: "string" },
          title: { type: "string", description: "Imperative, max 48 characters." },
          why: { type: "string", description: "One short clause, max 110 characters, citing the PM2.5 figure." },
        },
      },
    },
  },
} as const;

export const PlanPhrasingSchema = z.object({
  headline: z.string(),
  steps: z.array(z.object({ id: z.string(), title: z.string(), why: z.string() })),
});
export type PlanPhrasing = z.infer<typeof PlanPhrasingSchema>;

export function phrasingPrompt(input: {
  place: string;
  plan: ForecastPlan;
  sensitivity: string;
  room: string | null;
  focus?: string;
  space?: SpaceType;
  outdoorWindow?: string;
}): string {
  const steps = input.plan.steps.map((s) => ({
    id: s.id,
    from: s.startLocal,
    to: s.endLocal,
    risk: s.risk,
    facts: s.why,
    device: s.command ? `${s.command.action} ${s.command.deviceId}` : "none",
  }));
  return [
    "You phrase an indoor-air timeline for AirHealth Engineer. The times, risk levels and device actions are FIXED (computed from the CAMS forecast); never change, add or drop steps. Never give medical advice.",
    `Place: ${input.place}. Person: ${input.sensitivity}.${input.room ? ` Room: ${input.room}.` : ""}${input.space && isOpenSpace(input.space) ? " Open-air space: no purifier or windows." : ""}${input.focus ? ` Focus: ${input.focus}.` : ""}`,
    input.outdoorWindow ? `Best outdoor window (computed; mention exactly this if relevant): ${input.outdoorWindow}` : "",
    `Steps: ${JSON.stringify(steps)}`,
    "Return JSON: a headline and, for each id, a short title and why. Be brief.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function applyPhrasing(plan: ForecastPlan, ph: PlanPhrasing): ForecastPlan {
  const byId = new Map(ph.steps.map((s) => [s.id, s]));
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  return {
    headline: ph.headline.trim() ? clip(ph.headline.trim(), 140) : plan.headline,
    steps: plan.steps.map((s) => {
      const p = byId.get(s.id);
      return p ? { ...s, title: clip(p.title.trim() || s.title, 60), why: clip(p.why.trim() || s.why, 140) } : s;
    }),
  };
}
