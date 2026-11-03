/**
 * Real-time SAM 3.1 outlines on the live camera picture.
 *
 * The SAM 3.1 API tracks objects through video only for uploaded MP4/MOV clips
 * (input_video + file_id); there is no live/webcam stream input. So live mode
 * segments still keyframes (input_image, one concept per request, in
 * parallel) every ~1.5 s, and keeps the real SAM masks aligned between
 * keyframes with cheap client-side template matching on a small grey frame.
 * Masks are never invented: every outline drawn came from a SAM response and
 * is only moved (translated) or faded until the next keyframe replaces it.
 *
 * Everything here is pure so it runs in tests; the canvas lives in
 * components/camera/LiveSamOverlay.tsx.
 */

export interface LiveConcept {
  /** Noun phrase sent to SAM 3.1. */
  phrase: string;
  /** Short label drawn on the outline and the state chip. */
  label: string;
  colour: string;
  /** Minimum SAM confidence for the outline to count. */
  minConfidence: number;
}

export const LIVE_CONCEPTS: readonly LiveConcept[] = [
  { phrase: "window", label: "Window", colour: "#5aa9e6", minConfidence: 0.5 },
  { phrase: "door", label: "Door", colour: "#c08457", minConfidence: 0.5 },
  { phrase: "air purifier", label: "Purifier", colour: "#13b5a6", minConfidence: 0.45 },
  { phrase: "fan", label: "Fan", colour: "#9b7be0", minConfidence: 0.5 },
  { phrase: "air conditioner", label: "AC unit", colour: "#7bc96f", minConfidence: 0.5 },
  { phrase: "smoke", label: "Smoke/haze", colour: "#f97316", minConfidence: 0.45 },
  { phrase: "stove", label: "Stove", colour: "#ef4444", minConfidence: 0.5 },
  { phrase: "vent", label: "Vent", colour: "#f2a541", minConfidence: 0.5 },
  { phrase: "person", label: "Person", colour: "#e86a92", minConfidence: 0.5 },
] as const;

export const LIVE_PHRASES = LIVE_CONCEPTS.map((c) => c.phrase);
export const conceptFor = (phrase: string): LiveConcept | undefined => LIVE_CONCEPTS.find((c) => c.phrase === phrase);

export const LIVE_SAM_DEFAULTS = {
  /** Never send keyframes faster than this (ms), whatever the latency. */
  minIntervalMs: 1500,
  /** Slowest keyframe cadence when latency is high (ms). */
  maxIntervalMs: 4000,
  /** Keyframe width sent to SAM (px); small frames keep latency and upload down. */
  keyframeWidth: 512,
  /** Concepts per rotating keyframe ("smoke" + two rotating). Full sweeps send all nine. */
  conceptsPerKeyframe: 3,
  /** Session cost guard: keyframes and SAM images (one image = one concept request). */
  maxKeyframes: 120,
  maxSamImages: 400,
  /** Fallback (Muse Spark grounding) is slow and pricier: one read per 20 s at most. */
  fallbackIntervalMs: 20_000,
  /** Luma-thumbnail diff that counts as a scene change (re-segment everything). */
  sceneChangeThreshold: 0.09,
  /** Outlines fade after this age without a fresh SAM read, and are dropped later (ms). */
  fadeAfterMs: 4000,
  dropAfterMs: 15_000,
} as const;
export type LiveSamConfig = { [K in keyof typeof LIVE_SAM_DEFAULTS]: number };

/** SAM 3.1 image segmentation list price: $2.50 per 1,000 images (one image per concept request). */
export const SAM_IMAGE_USD = 2.5 / 1000;

/** Keyframe cadence from measured round-trip latency: at least minInterval, roughly latency + 20 %. */
export function keyframeInterval(latencyMs: number | null, cfg: Partial<LiveSamConfig> = {}): number {
  const c = { ...LIVE_SAM_DEFAULTS, ...cfg };
  if (latencyMs === null || !Number.isFinite(latencyMs)) return c.minIntervalMs;
  return Math.round(Math.min(c.maxIntervalMs, Math.max(c.minIntervalMs, latencyMs * 1.2)));
}

/**
 * Which concepts a keyframe segments. Full sweeps (first frame, scene change)
 * send all of them; otherwise smoke every time (it is what changes the plan
 * fastest) plus a rotating pair, so each object is refreshed every ~4 keyframes.
 */
export function conceptsForKeyframe(index: number, full: boolean, cfg: Partial<LiveSamConfig> = {}): string[] {
  if (full) return [...LIVE_PHRASES];
  const per = Math.max(1, ({ ...LIVE_SAM_DEFAULTS, ...cfg }).conceptsPerKeyframe);
  const rest = LIVE_PHRASES.filter((p) => p !== "smoke");
  const k = per - 1;
  const out = ["smoke"];
  for (let i = 0; i < k; i++) out.push(rest[(index * k + i) % rest.length]!);
  return [...new Set(out)];
}

export interface LiveSamBudget {
  keyframes: number;
  samImages: number;
  inFlight: boolean;
  lastSentAt: number | null;
}
export const initialSamBudget = (): LiveSamBudget => ({ keyframes: 0, samImages: 0, inFlight: false, lastSentAt: null });

export type KeyframeDecision =
  | { send: true; full: boolean; concepts: string[] }
  | { send: false; reason: "in_flight" | "too_soon" | "budget_spent" | "hidden" };

/** Cost guard + cadence for the next keyframe. */
export function decideKeyframe(
  b: LiveSamBudget,
  now: number,
  opts: { latencyMs: number | null; sceneChanged: boolean; hidden?: boolean; fallback?: boolean; cfg?: Partial<LiveSamConfig> },
): KeyframeDecision {
  const c = { ...LIVE_SAM_DEFAULTS, ...opts.cfg };
  if (opts.hidden) return { send: false, reason: "hidden" };
  if (b.inFlight) return { send: false, reason: "in_flight" };
  const full = b.keyframes === 0 || opts.sceneChanged;
  const concepts = conceptsForKeyframe(b.keyframes, full, c);
  if (b.keyframes >= c.maxKeyframes || b.samImages + concepts.length > c.maxSamImages) return { send: false, reason: "budget_spent" };
  const gap = opts.fallback ? c.fallbackIntervalMs : keyframeInterval(opts.latencyMs, c);
  if (b.lastSentAt !== null && now - b.lastSentAt < gap) return { send: false, reason: "too_soon" };
  return { send: true, full, concepts };
}

/* ------------------------------------------------------------------ */
/* Regions                                                              */
/* ------------------------------------------------------------------ */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface LiveRegion {
  id: string;
  /** SAM phrase (or the Muse Spark label in fallback mode). */
  concept: string;
  label: string;
  box: Box;
  mask?: { path: string; width: number; height: number };
  confidence?: number;
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = ix * iy;
  const area = (r: Box) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const u = area(a) + area(b) - inter;
  return u > 0 ? inter / u : 0;
}

/**
 * Drop weak matches and cross-concept duplicates: SAM answers each phrase
 * independently, so a purifier can also come back (weaker) as "air conditioner".
 */
const DEDUPE_PRIORITY: Record<string, number> = { "air purifier": 1 };

export function cleanRegions<R extends LiveRegion>(regions: R[]): R[] {
  const strong = regions.filter((r) => (r.confidence ?? 1) >= (conceptFor(r.concept)?.minConfidence ?? 0.5));
  // When two concepts claim the same object, the more specific one wins first (SAM's "air conditioner"
  // also matches floor-standing purifiers), then the more confident one.
  strong.sort((a, b) => (DEDUPE_PRIORITY[b.concept] ?? 0) - (DEDUPE_PRIORITY[a.concept] ?? 0) || (b.confidence ?? 0) - (a.confidence ?? 0));
  const kept: R[] = [];
  for (const r of strong) {
    if (kept.some((k) => k.concept !== r.concept && iou(k.box, r.box) > 0.6)) continue;
    kept.push(r);
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* State chips derived from the masks                                    */
/* ------------------------------------------------------------------ */

export interface SamSceneState {
  counts: Record<string, number>;
  /** Window glass/opening appearance changed vs. when it was first outlined. */
  windowChanged: boolean;
}

export const emptySamState = (): SamSceneState => ({ counts: {}, windowChanged: false });

export function samStateFrom(regions: LiveRegion[], windowChanged = false): SamSceneState {
  const counts: Record<string, number> = {};
  for (const r of regions) counts[r.concept] = (counts[r.concept] ?? 0) + 1;
  return { counts, windowChanged };
}

export interface StateChip {
  key: string;
  text: string;
  tone: "ok" | "info" | "alert";
}

/** Chips for the HUD. Only claims what the masks show. */
export function stateChips(s: SamSceneState, segmented: ReadonlySet<string>): StateChip[] {
  const out: StateChip[] = [];
  const n = (p: string) => s.counts[p] ?? 0;
  if (segmented.has("smoke")) out.push(n("smoke") ? { key: "smoke", text: "Smoke/haze: detected", tone: "alert" } : { key: "smoke", text: "Smoke/haze: none seen", tone: "ok" });
  if (segmented.has("window")) {
    if (n("window")) out.push({ key: "window", text: s.windowChanged ? "Window: changed (opened or closed?)" : `Window: in view${n("window") > 1 ? ` ×${n("window")}` : ""}`, tone: s.windowChanged ? "alert" : "info" });
    else out.push({ key: "window", text: "Window: not in view", tone: "info" });
  }
  if (segmented.has("stove") && n("stove")) out.push({ key: "stove", text: "Stove: in view", tone: "alert" });
  for (const p of ["air purifier", "fan", "air conditioner", "door", "vent", "person"]) {
    if (!segmented.has(p) || !n(p)) continue;
    const c = conceptFor(p)!;
    out.push({ key: p, text: `${c.label}: ${n(p) > 1 ? `×${n(p)}` : "in view"}`, tone: "info" });
  }
  return out;
}

/**
 * Plan-relevant changes between two mask-derived states. Only compares
 * concepts segmented in the newer keyframe, so rotation never reads as
 * "disappeared".
 */
export function samStateChanges(prev: SamSceneState, next: SamSceneState, segmentedNow: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const had = (p: string) => (prev.counts[p] ?? 0) > 0;
  const has = (p: string) => (next.counts[p] ?? 0) > 0;
  const check = (p: string, appeared: string, gone: string) => {
    if (!segmentedNow.has(p)) return;
    if (!had(p) && has(p)) out.push(appeared);
    else if (had(p) && !has(p)) out.push(gone);
  };
  check("smoke", "smoke/haze appeared", "smoke/haze cleared");
  check("stove", "stove/cooking source now in view", "stove no longer in view");
  check("window", "window now in view", "window no longer in view");
  check("air purifier", "purifier now in view", "purifier no longer in view");
  check("fan", "fan now in view", "fan no longer in view");
  check("air conditioner", "AC unit now in view", "AC unit no longer in view");
  if (!prev.windowChanged && next.windowChanged) out.push("window opened or closed (its outlined area changed)");
  return out.map((c) => `SAM 3.1: ${c}`);
}

/* ------------------------------------------------------------------ */
/* Lightweight tracking between keyframes                               */
/* ------------------------------------------------------------------ */

export interface GreyFrame {
  w: number;
  h: number;
  data: Float32Array;
}

export function greyFromRgba(rgba: ArrayLike<number>, w: number, h: number): GreyFrame {
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = (0.299 * (rgba[i * 4] ?? 0) + 0.587 * (rgba[i * 4 + 1] ?? 0) + 0.114 * (rgba[i * 4 + 2] ?? 0)) / 255;
  return { w, h, data };
}

/**
 * Template matching: where did the patch `box` of `ref` move to in `cur`?
 * Searches ±radius around `start` (grey-frame pixels) by mean absolute
 * difference, sampling the patch with a stride so big regions stay cheap.
 */
export function matchShift(
  ref: GreyFrame,
  cur: GreyFrame,
  box: Box,
  start: { dx: number; dy: number } = { dx: 0, dy: 0 },
  radius = 4,
): { dx: number; dy: number; error: number } {
  const l = Math.max(0, Math.floor(box.left));
  const t = Math.max(0, Math.floor(box.top));
  const r = Math.min(ref.w, Math.ceil(box.right));
  const b = Math.min(ref.h, Math.ceil(box.bottom));
  const pw = r - l;
  const ph = b - t;
  if (pw < 3 || ph < 3) return { ...start, error: 1 };
  const stride = Math.max(1, Math.floor(Math.sqrt((pw * ph) / 400)));
  let best = { dx: start.dx, dy: start.dy, error: Infinity };
  for (let oy = start.dy - radius; oy <= start.dy + radius; oy++) {
    for (let ox = start.dx - radius; ox <= start.dx + radius; ox++) {
      let sum = 0;
      let n = 0;
      for (let y = t; y < b; y += stride) {
        const cy = y + oy;
        if (cy < 0 || cy >= cur.h) continue;
        for (let x = l; x < r; x += stride) {
          const cx = x + ox;
          if (cx < 0 || cx >= cur.w) continue;
          sum += Math.abs(ref.data[y * ref.w + x]! - cur.data[cy * cur.w + cx]!);
          n++;
        }
      }
      if (n < 6) continue;
      const e = sum / n;
      // Prefer the smaller motion on ties so a still scene stays put.
      if (e < best.error - 1e-6 || (Math.abs(e - best.error) <= 1e-6 && Math.hypot(ox, oy) < Math.hypot(best.dx, best.dy))) best = { dx: ox, dy: oy, error: e };
    }
  }
  return best.error === Infinity ? { ...start, error: 1 } : best;
}

/** Mean and spread of grey levels inside a box (used for the window-state heuristic). */
export function patchStats(f: GreyFrame, box: Box): { mean: number; std: number } {
  const l = Math.max(0, Math.floor(box.left));
  const t = Math.max(0, Math.floor(box.top));
  const r = Math.min(f.w, Math.ceil(box.right));
  const b = Math.min(f.h, Math.ceil(box.bottom));
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = t; y < b; y++)
    for (let x = l; x < r; x++) {
      const v = f.data[y * f.w + x]!;
      s += v;
      s2 += v * v;
      n++;
    }
  if (!n) return { mean: 0, std: 0 };
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}

/**
 * The window's outlined area looks different from when SAM first outlined it
 * (sash slid, curtain or view changed) while the window itself stayed put.
 * This cannot tell open from closed on its own, so the chip says "opened or
 * closed?" and the plan flow asks Muse Spark to read the frame.
 */
export function windowAppearanceChanged(base: { mean: number; std: number }, now: { mean: number; std: number }): boolean {
  return Math.abs(now.mean - base.mean) > 0.08 || Math.abs(now.std - base.std) > 0.05;
}

/** Outline opacity from age since its last SAM confirmation. Reduced motion: no gradual fade. */
export function regionAlpha(ageMs: number, reducedMotion: boolean, cfg: Partial<LiveSamConfig> = {}): number {
  const c = { ...LIVE_SAM_DEFAULTS, ...cfg };
  if (ageMs >= c.dropAfterMs) return 0;
  if (ageMs <= c.fadeAfterMs) return 1;
  if (reducedMotion) return 0.6;
  const k = (ageMs - c.fadeAfterMs) / (c.dropAfterMs - c.fadeAfterMs);
  return Math.max(0.25, 1 - 0.75 * k);
}

/** Object-fit: cover mapping from a video frame to the stage box. */
export function coverTransform(vw: number, vh: number, sw: number, sh: number): { scale: number; ox: number; oy: number } {
  if (!vw || !vh) return { scale: 1, ox: 0, oy: 0 };
  const scale = Math.max(sw / vw, sh / vh);
  return { scale, ox: (sw - vw * scale) / 2, oy: (sh - vh * scale) / 2 };
}
