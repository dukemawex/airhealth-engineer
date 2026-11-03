import { z } from "zod";
import { SPACE_TYPES, type SpaceType } from "./space";
import { SceneAnalysisSchema } from "./vision/scene";
import type { ChatMessage, ToolCall } from "./meta/types";

/* ------------------------------------------------------------------ */
/* Location                                                            */
/* ------------------------------------------------------------------ */

export const LocationQuerySchema = z
  .object({
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    accuracyMeters: z.number().min(0).max(1_000_000).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "ISO 3166-1 alpha-2 country code, e.g. NG, IN, BR")
      .optional(),
  })
  .refine(
    (v) => (v.latitude !== undefined && v.longitude !== undefined) || v.city !== undefined,
    "Provide latitude+longitude or a city name",
  );
export type LocationQuery = z.infer<typeof LocationQuerySchema>;

export interface ResolvedLocation {
  latitude: number;
  longitude: number;
  /** Neighbourhood / suburb, when known (reverse geocoding or a precise search hit). */
  area?: string;
  /** City, town or village. */
  name?: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
  timezone?: string;
  source: "user_coordinates" | "geocoded";
  /** Which service named the place: Open-Meteo search, Nominatim search, or Nominatim reverse. */
  resolvedBy?: "open-meteo" | "nominatim" | "nominatim-reverse";
  /** Browser-reported accuracy for shared coordinates, in metres. */
  accuracyMeters?: number;
  /** What the user typed, kept so the UI can show "you typed X, we found Y". */
  query?: string;
}

/* ------------------------------------------------------------------ */
/* Health profile                                                      */
/* ------------------------------------------------------------------ */

export const HealthProfileSchema = z.object({
  ageGroup: z.enum(["infant", "child", "teen", "adult", "older_adult"]).optional(),
  conditions: z
    .array(z.string().trim().min(1).max(120))
    .max(30)
    .default([])
    .describe("Diagnosed conditions, e.g. asthma, COPD, heart disease, pregnancy"),
  symptoms: z
    .array(z.string().trim().min(1).max(120))
    .max(30)
    .default([])
    .describe("Current symptoms, e.g. wheezing, cough, headache, chest tightness"),
  medications: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  recentData: z
    .object({
      spo2Percent: z.number().min(50).max(100).optional(),
      heartRateBpm: z.number().min(20).max(250).optional(),
      respiratoryRatePerMin: z.number().min(4).max(80).optional(),
      peakFlowLpm: z.number().min(30).max(1000).optional(),
      personalBestPeakFlowLpm: z.number().min(30).max(1000).optional(),
      indoorPm25: z.number().min(0).max(2000).optional(),
      indoorCo2Ppm: z.number().min(250).max(10000).optional(),
      indoorHumidityPercent: z.number().min(0).max(100).optional(),
      notes: z.string().max(1000).optional(),
      measuredAt: z.string().max(40).optional(),
    })
    .optional(),
  activityPlans: z.string().max(500).optional().describe("e.g. 'cycling to work at 08:00'"),
  household: z
    .array(z.string().trim().min(1).max(120))
    .max(10)
    .optional()
    .describe("Sensitive people sharing the home, e.g. child, infant, older adult, pregnant person"),
  activities: z
    .array(z.string().trim().min(1).max(120))
    .max(10)
    .optional()
    .describe("Regular outdoor exposure, e.g. works outdoors, runs or exercises outdoors"),
});
export type HealthProfile = z.infer<typeof HealthProfileSchema>;

/* ------------------------------------------------------------------ */
/* Air quality                                                         */
/* ------------------------------------------------------------------ */

export interface PollutantReading {
  parameter: string; // pm25, pm10, no2, o3, so2, co, ...
  value: number;
  units: string;
  observedAt?: string;
  stationName?: string;
  distanceKm?: number;
  stale?: boolean;
}

export interface AirQualitySnapshot {
  location: ResolvedLocation;
  source: "openaq" | "open-meteo-cams-model";
  sourceNote: string;
  fetchedAt: string;
  readings: PollutantReading[];
  pm25Category?: AqiCategory;
  stationsConsidered?: number;
  /** Distance to the nearest station that supplied a reading, km. */
  nearestStationKm?: number;
  /** Search radius that found the stations, km (widened automatically when nothing is near). */
  searchRadiusKm?: number;
}

export type AqiCategory =
  | "good"
  | "moderate"
  | "unhealthy_for_sensitive_groups"
  | "unhealthy"
  | "very_unhealthy"
  | "hazardous";

/* ------------------------------------------------------------------ */
/* Device commands (shared by designIntervention and executeDeviceAction) */
/* ------------------------------------------------------------------ */

const HvacCommand = z.object({
  deviceType: z.literal("hvac"),
  deviceId: z.string().trim().min(1).max(200).describe("Device/entity id, e.g. climate.living_room"),
  action: z.enum(["set_mode", "set_temperature", "set_fan_mode", "set_fresh_air_intake"]),
  mode: z.enum(["off", "cool", "heat", "auto", "dry", "fan_only"]).optional(),
  temperatureC: z.number().min(10).max(32).optional(),
  fanMode: z.enum(["auto", "low", "medium", "high"]).optional(),
  freshAirPercent: z.number().int().min(0).max(100).optional(),
});

const PurifierCommand = z.object({
  deviceType: z.literal("air_purifier"),
  deviceId: z.string().trim().min(1).max(200).describe("Device/entity id, e.g. fan.bedroom_purifier"),
  action: z.enum(["turn_on", "turn_off", "set_fan_speed", "set_mode"]),
  fanSpeedPercent: z.number().int().min(0).max(100).optional(),
  mode: z.enum(["auto", "sleep", "turbo", "manual"]).optional(),
});

const WindowCommand = z.object({
  deviceType: z.literal("window"),
  deviceId: z.string().trim().min(1).max(200).describe("Device/entity id, e.g. cover.kitchen_window"),
  action: z.enum(["open", "close", "set_position"]),
  positionPercent: z.number().int().min(0).max(100).optional(),
});

export const DeviceCommandSchema = z
  .discriminatedUnion("deviceType", [HvacCommand, PurifierCommand, WindowCommand])
  .superRefine((cmd, ctx) => {
    const need = (field: string, ok: boolean) => {
      if (!ok) ctx.addIssue({ code: "custom", message: `${field} is required for ${cmd.deviceType}.${cmd.action}` });
    };
    if (cmd.deviceType === "hvac") {
      if (cmd.action === "set_mode") need("mode", cmd.mode !== undefined);
      if (cmd.action === "set_temperature") need("temperatureC", cmd.temperatureC !== undefined);
      if (cmd.action === "set_fan_mode") need("fanMode", cmd.fanMode !== undefined);
      if (cmd.action === "set_fresh_air_intake") need("freshAirPercent", cmd.freshAirPercent !== undefined);
    } else if (cmd.deviceType === "air_purifier") {
      if (cmd.action === "set_fan_speed") need("fanSpeedPercent", cmd.fanSpeedPercent !== undefined);
      if (cmd.action === "set_mode") need("mode", cmd.mode !== undefined);
    } else if (cmd.deviceType === "window") {
      if (cmd.action === "set_position") need("positionPercent", cmd.positionPercent !== undefined);
    }
  });
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;

/* ------------------------------------------------------------------ */
/* Intervention design                                                 */
/* ------------------------------------------------------------------ */

/** Ventilation modes that need an enclosed room; dropped or mapped for open spaces. */
export const INDOOR_VENT_MODES = ["closed_recirculate", "mechanical_filtered", "windows_open", "purge"] as const;
/** Airflow steps for open-sided or outdoor spaces. */
export const OPEN_AIR_MODES = ["open_dispersion", "stay_upwind", "reduce_source"] as const;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 24h local time");

export const InterventionDesignSchema = z.object({
  title: z.string().trim().min(3).max(160),
  objective: z.string().trim().min(3).max(1000),
  riskSummary: z.string().trim().min(3).max(1500),
  space: z
    .enum(SPACE_TYPES)
    .optional()
    .describe(
      "Where the exposure happens: indoor (enclosed room), semi_open (open-sided shelter, veranda, open-air kitchen) or outdoor. Defaults to the latest photo's setting. semi_open and outdoor plans get no purifier CADR/ACH target and no window or HVAC schedule.",
    ),
  room: z
    .object({
      name: z.string().max(80).optional(),
      floorAreaM2: z.number().positive().max(5000),
      ceilingHeightM: z.number().positive().max(20).default(2.7),
    })
    .optional(),
  filtration: z.object({
    recommendedFilterClass: z.enum([
      "MERV13",
      "MERV14",
      "MERV16",
      "HEPA_H13",
      "HEPA_H14",
      "ACTIVATED_CARBON",
      "HEPA_PLUS_CARBON",
      "NONE",
    ]),
    targetAirChangesPerHour: z.number().min(0).max(20).optional(),
    purifierFanSetting: z.string().max(80).optional(),
    replaceAfterHours: z.number().int().positive().max(20000).optional(),
    notes: z.string().max(1000).optional(),
  }),
  ventilation: z.object({
    strategy: z.enum(["seal_and_recirculate", "controlled_mechanical", "natural_when_clean", "purge", "open_air_dispersion"]),
    schedule: z
      .array(
        z.object({
          start: HHMM,
          end: HHMM,
          mode: z.enum([...INDOOR_VENT_MODES, ...OPEN_AIR_MODES]),
          freshAirPercent: z.number().int().min(0).max(100).optional(),
          rationale: z.string().max(400),
        }),
      )
      .max(24)
      .default([]),
    notes: z.string().max(1000).optional(),
  }),
  routeAlternatives: z
    .array(
      z.object({
        description: z.string().max(400),
        avoid: z.array(z.string().max(160)).max(20).default([]),
        recommendedTimeWindow: z.string().max(80).optional(),
        estimatedExposureReductionPercent: z.number().min(0).max(100).optional(),
      }),
    )
    .max(10)
    .default([]),
  deviceCommands: z.array(DeviceCommandSchema).max(20).default([]),
  exposureSteps: z
    .array(z.string().max(400))
    .max(20)
    .default([])
    .describe("Practical steps that cut exposure (move upwind, shorten time near smoke, cleaner hours). Environment only, never medical advice."),
  monitoringPlan: z.object({
    recheckIntervalMinutes: z.number().int().min(5).max(1440),
    escalationTriggers: z.array(z.string().max(300)).max(20).default([]),
  }),
});
export type InterventionDesign = z.infer<typeof InterventionDesignSchema>;

export interface EngineeringChecks {
  roomVolumeM3?: number;
  requiredCadrM3h?: number;
  requiredCadrCfm?: number;
  targetAirChangesPerHour?: number;
  outdoorPm25?: number;
  outdoorPm25Category?: AqiCategory;
  /** Space the checks were computed for; indoor sizing is skipped for open spaces. */
  space?: SpaceType;
  /** Indoor-only items skipped for this space, with the reason. */
  notApplicable?: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Persisted records                                                   */
/* ------------------------------------------------------------------ */

export type InterventionStatus = "proposed" | "active" | "completed" | "cancelled";

export interface Intervention {
  id: string;
  sessionId: string;
  status: InterventionStatus;
  createdAt: string;
  updatedAt: string;
  design: InterventionDesign;
  checks: EngineeringChecks;
  location?: ResolvedLocation;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";

export interface DeviceActionResult {
  ok: boolean;
  adapter: string;
  executedAt: string;
  message: string;
  deviceState?: Record<string, unknown>;
  raw?: unknown;
}

export interface Approval {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  status: ApprovalStatus;
  command: DeviceCommand;
  reason: string;
  interventionId?: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  result?: DeviceActionResult;
}

export type SessionStatus = "idle" | "running" | "awaiting_approval" | "error";

export interface PendingTurn {
  /** The tool calls from the assistant message that triggered the pause, in order. */
  toolCalls: ToolCall[];
  /** Tool results already available, keyed by tool_call_id (JSON strings). */
  results: Record<string, string>;
  /** Approval ids that must be decided before the loop can resume. */
  approvalIds: string[];
}

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  messages: ChatMessage[];
  profile?: HealthProfile;
  location?: ResolvedLocation;
  lastAirQuality?: AirQualitySnapshot;
  pendingTurn?: PendingTurn;
  lastError?: string;
  /** Recent outdoor PM2.5 points (from real snapshots only) for trend display. */
  airQualityHistory?: Array<{ at: string; pm25?: number; source: AirQualitySnapshot["source"] }>;
  monitoring?: MonitoringState;
  /** Opaque, stable end-user id hint forwarded as safety_identifier (hashed). */
  userRef?: string;
  /** Latest photo analysis (structured output only; the image itself is never stored). */
  scene?: SessionScene;
}

export const SessionSceneSchema = z.object({
  capturedAt: z.string().max(40),
  analysis: SceneAnalysisSchema,
  overlay: z.object({
    source: z.enum(["sam-3.1", "muse-spark-grounding"]),
    labels: z.array(z.string().max(80)).max(12),
  }),
});
export type SessionScene = z.infer<typeof SessionSceneSchema>;

export interface MonitoringDecision {
  at: string;
  notify: boolean;
  severity: "info" | "watch" | "act";
  message: string;
}

export interface MonitoringState {
  enabled: boolean;
  lastCheckAt?: string;
  lastNotifiedAt?: string;
  lastDecision?: MonitoringDecision;
  lastError?: string;
}
