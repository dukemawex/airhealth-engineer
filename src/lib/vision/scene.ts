import { z } from "zod";

/**
 * Structured scene analysis produced by Muse Spark image understanding with
 * response_format json_schema (constrained decoding). Shared by the server
 * route and the client card, so it must stay free of Node-only imports.
 *
 * Boxes use Muse Spark's perception grid: normalised 0-1000 coordinates
 * (https://dev.meta.ai/docs/image-understanding).
 */

export const HAZE_LEVELS = ["none", "light", "moderate", "heavy", "unclear"] as const;
export const SETTINGS = ["indoor", "outdoor", "window_view", "unclear"] as const;
export const FILTER_STATES = ["clean", "dusty", "dirty", "not_visible"] as const;
export const SOURCE_KINDS = ["combustion", "traffic", "cooking", "dust", "mould_damp", "smoke", "industrial", "other"] as const;

export const SceneBoxSchema = z.object({
  label: z.string().max(80),
  x_min: z.number(),
  y_min: z.number(),
  x_max: z.number(),
  y_max: z.number(),
});

export const SceneAnalysisSchema = z.object({
  summary: z.string().max(600),
  setting: z.enum(SETTINGS),
  visibleHaze: z.enum(HAZE_LEVELS),
  hazeEvidence: z.string().max(400),
  estimatedVisibilityKm: z.number().min(0).max(100).nullable(),
  pollutionSources: z
    .array(z.object({ name: z.string().max(80), kind: z.enum(SOURCE_KINDS), note: z.string().max(200) }))
    .max(6),
  room: z.object({
    windows: z.number().int().min(0).max(20),
    doors: z.number().int().min(0).max(20),
    purifierVisible: z.boolean(),
    fanOrAcVisible: z.boolean(),
    ventsVisible: z.boolean(),
    filterCondition: z.enum(FILTER_STATES),
    estimatedFloorAreaM2: z.number().min(0).max(500).nullable(),
  }),
  engineeringNotes: z.array(z.string().max(240)).max(6),
  segmentTargets: z.array(z.string().max(40)).max(3),
  boxes: z.array(SceneBoxSchema).max(8),
  confidence: z.enum(["low", "medium", "high"]),
});
export type SceneAnalysis = z.infer<typeof SceneAnalysisSchema>;

/** Strict JSON schema for response_format (every object closed, every key required). */
export const SCENE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "setting",
    "visibleHaze",
    "hazeEvidence",
    "estimatedVisibilityKm",
    "pollutionSources",
    "room",
    "engineeringNotes",
    "segmentTargets",
    "boxes",
    "confidence",
  ],
  properties: {
    summary: { type: "string", description: "Two sentences: what the photo shows that matters for indoor air." },
    setting: { type: "string", enum: [...SETTINGS] },
    visibleHaze: { type: "string", enum: [...HAZE_LEVELS], description: "Visible haze/smog/smoke in the air or through windows." },
    hazeEvidence: { type: "string", description: "The visual cues behind the haze judgement (contrast loss, colour cast, skyline blur)." },
    estimatedVisibilityKm: {
      type: ["number", "null"],
      description: "Rough horizontal visibility if a distant skyline is visible, else null.",
    },
    pollutionSources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind", "note"],
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: [...SOURCE_KINDS] },
          note: { type: "string" },
        },
      },
    },
    room: {
      type: "object",
      additionalProperties: false,
      required: ["windows", "doors", "purifierVisible", "fanOrAcVisible", "ventsVisible", "filterCondition", "estimatedFloorAreaM2"],
      properties: {
        windows: { type: "integer" },
        doors: { type: "integer" },
        purifierVisible: { type: "boolean" },
        fanOrAcVisible: { type: "boolean" },
        ventsVisible: { type: "boolean" },
        filterCondition: { type: "string", enum: [...FILTER_STATES] },
        estimatedFloorAreaM2: { type: ["number", "null"] },
      },
    },
    engineeringNotes: {
      type: "array",
      items: { type: "string" },
      description: "Concrete indoor-air engineering observations (sealing gaps, purifier placement, filter swap). No medical advice.",
    },
    segmentTargets: {
      type: "array",
      items: { type: "string" },
      description: "Up to 3 short concrete noun phrases worth outlining, e.g. 'haze', 'window', 'air purifier', 'smoke'.",
    },
    boxes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "x_min", "y_min", "x_max", "y_max"],
        properties: {
          label: { type: "string" },
          x_min: { type: "number" },
          y_min: { type: "number" },
          x_max: { type: "number" },
          y_max: { type: "number" },
        },
      },
      description: "Bounding boxes on the 0-1000 normalised grid for the most air-relevant regions.",
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
};

/** Clamp/clean a model-produced analysis: boxes to 0-1000 with x_min<x_max, sane lengths. */
export function normaliseScene(raw: SceneAnalysis): SceneAnalysis {
  const clamp = (n: number) => Math.min(1000, Math.max(0, Math.round(n)));
  const boxes = raw.boxes
    .map((b) => {
      const x1 = clamp(Math.min(b.x_min, b.x_max));
      const x2 = clamp(Math.max(b.x_min, b.x_max));
      const y1 = clamp(Math.min(b.y_min, b.y_max));
      const y2 = clamp(Math.max(b.y_min, b.y_max));
      return { label: b.label.trim().slice(0, 80), x_min: x1, y_min: y1, x_max: x2, y_max: y2 };
    })
    .filter((b) => b.x_max - b.x_min >= 4 && b.y_max - b.y_min >= 4);
  const targets = [...new Set(raw.segmentTargets.map((t) => t.trim().toLowerCase()).filter((t) => /^[a-z][a-z \-']{1,38}$/.test(t)))].slice(0, 3);
  return { ...raw, boxes, segmentTargets: targets };
}

/** One overlay region to draw over the photo (pixel space of the analysed image). */
export interface OverlayRegion {
  id: string;
  label: string;
  box: { left: number; top: number; right: number; bottom: number };
  /** SVG path in mask-raster coordinates; scale by box size / raster size. */
  mask?: { path: string; width: number; height: number };
  confidence?: number;
}

export interface SceneOverlay {
  /** Which Meta model produced the outlines. */
  source: "sam-3.1" | "muse-spark-grounding";
  width: number;
  height: number;
  regions: OverlayRegion[];
  /** Why SAM 3.1 was not used, when the source is the fallback. */
  fallbackReason?: string;
}

export interface VisionResult {
  analysis: SceneAnalysis;
  overlay: SceneOverlay;
  models: { vision: string; segmentation: string | null };
  timings: { visionMs: number; segmentationMs: number | null };
}

/** Text block the agent receives about the latest photo (never the image itself). */
export function describeSceneForAgent(a: SceneAnalysis, overlay?: { source: SceneOverlay["source"]; labels: string[] }): string {
  const parts = [
    `Photo analysis (Muse Spark vision, ${a.confidence} confidence): ${a.summary}`,
    `Setting: ${a.setting}. Visible haze: ${a.visibleHaze} (${a.hazeEvidence})${a.estimatedVisibilityKm !== null ? `; est. visibility ~${a.estimatedVisibilityKm} km` : ""}.`,
    `Room: ${a.room.windows} window(s), ${a.room.doors} door(s), purifier ${a.room.purifierVisible ? "visible" : "not visible"}, fan/AC ${a.room.fanOrAcVisible ? "visible" : "not visible"}, vents ${a.room.ventsVisible ? "visible" : "not visible"}, filter ${a.room.filterCondition.replace("_", " ")}${a.room.estimatedFloorAreaM2 ? `, floor area ~${a.room.estimatedFloorAreaM2} m² (visual estimate; confirm with the user)` : ""}.`,
  ];
  if (a.pollutionSources.length) parts.push(`Possible sources: ${a.pollutionSources.map((s) => `${s.name} (${s.kind})`).join(", ")}.`);
  if (a.engineeringNotes.length) parts.push(`Engineering notes: ${a.engineeringNotes.join(" | ")}`);
  if (overlay?.labels.length) {
    parts.push(`Outlined by ${overlay.source === "sam-3.1" ? "SAM 3.1 segmentation" : "Muse Spark grounding boxes"}: ${[...new Set(overlay.labels)].join(", ")}.`);
  }
  parts.push("A photo is visual evidence only: it cannot measure PM2.5. Prefer measured/modelled data for numbers.");
  return parts.join("\n");
}
