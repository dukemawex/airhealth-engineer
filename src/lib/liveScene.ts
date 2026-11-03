import type { SceneAnalysis } from "./vision/scene";

/**
 * Live camera mode: cheap client-side change detection decides when a frame is
 * worth sending to Muse Spark + SAM 3.1. Pure functions so they run in tests.
 */

export const LIVE_DEFAULTS = {
  /** How often a tiny thumbnail is compared (ms). */
  tickMs: 6000,
  /** Downscaled thumbnail used for the diff. */
  thumbW: 32,
  thumbH: 24,
  /** Mean absolute luma change (0..1) that counts as "the scene changed". */
  changeThreshold: 0.07,
  /** Never analyse more often than this, even if the scene keeps changing (ms). */
  minGapMs: 20_000,
  /** Hard cap of vision calls per live session (cost guard). */
  maxAnalyses: 10,
} as const;
export type LiveConfig = { [K in keyof typeof LIVE_DEFAULTS]: number };

/** RGBA pixels -> luma 0..1 per pixel. */
export function lumaSignature(rgba: ArrayLike<number>, pixels: number): Float32Array {
  const out = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    out[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  return out;
}

/**
 * Mean absolute luma difference, after removing the global brightness shift so
 * auto-exposure drift alone does not trigger a re-analysis.
 */
export function frameDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] ?? 0;
    mb += b[i] ?? 0;
  }
  const shift = (mb - ma) / n;
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs((b[i] ?? 0) - (a[i] ?? 0) - shift);
  return d / n;
}

export interface LiveState {
  analyses: number;
  lastAnalysisAt: number | null;
  inFlight: boolean;
}
export const initialLiveState = (): LiveState => ({ analyses: 0, lastAnalysisAt: null, inFlight: false });

export type LiveDecision =
  | { analyze: true; reason: "baseline" | "scene_changed" }
  | { analyze: false; reason: "in_flight" | "unchanged" | "cooldown" | "budget_spent" | "blocked" };

/** Decide whether this tick should spend a vision call. `diff` is null when there is no baseline yet. */
export function decideLiveTick(
  s: LiveState,
  now: number,
  diff: number | null,
  opts: { blocked?: boolean; cfg?: Partial<LiveConfig> } = {},
): LiveDecision {
  const cfg = { ...LIVE_DEFAULTS, ...opts.cfg };
  if (s.inFlight) return { analyze: false, reason: "in_flight" };
  if (s.analyses >= cfg.maxAnalyses) return { analyze: false, reason: "budget_spent" };
  if (opts.blocked) return { analyze: false, reason: "blocked" };
  if (diff === null) return { analyze: true, reason: "baseline" };
  if (diff < cfg.changeThreshold) return { analyze: false, reason: "unchanged" };
  if (s.lastAnalysisAt !== null && now - s.lastAnalysisAt < cfg.minGapMs) return { analyze: false, reason: "cooldown" };
  return { analyze: true, reason: "scene_changed" };
}

const nice = (s: string) => s.replace(/_/g, " ");

/**
 * Engineering-relevant differences between two scene readings. Only changes
 * that should alter the plan are reported (an empty list means "no re-plan").
 */
export function sceneChanges(prev: SceneAnalysis, next: SceneAnalysis): string[] {
  const out: string[] = [];
  const pw = prev.room.windows;
  const nw = next.room.windows;
  if (nw !== pw) out.push(nw > pw ? `more open windows in view (${pw} → ${nw}): window opened?` : `fewer windows in view (${pw} → ${nw}): window closed?`);
  if (next.room.doors !== prev.room.doors) out.push(`doors in view ${prev.room.doors} → ${next.room.doors}`);
  if (next.setting !== prev.setting) out.push(`space looks ${nice(next.setting)} (was ${nice(prev.setting)})`);
  if (next.visibleHaze !== prev.visibleHaze) out.push(`visible haze ${nice(prev.visibleHaze)} → ${nice(next.visibleHaze)}`);
  if (next.room.purifierVisible !== prev.room.purifierVisible)
    out.push(next.room.purifierVisible ? "purifier now in view" : "purifier no longer in view");
  if (next.room.fanOrAcVisible !== prev.room.fanOrAcVisible)
    out.push(next.room.fanOrAcVisible ? "fan or AC now in view" : "fan or AC no longer in view");
  if (next.room.filterCondition !== prev.room.filterCondition && next.room.filterCondition !== "not_visible" && prev.room.filterCondition !== "not_visible")
    out.push(`filter looks ${nice(next.room.filterCondition)} (was ${nice(prev.room.filterCondition)})`);
  const before = new Set(prev.pollutionSources.map((s) => s.kind));
  const added = [...new Set(next.pollutionSources.map((s) => s.kind))].filter((k) => !before.has(k));
  const after = new Set(next.pollutionSources.map((s) => s.kind));
  const gone = [...before].filter((k) => !after.has(k));
  for (const k of added) out.push(`new ${nice(k)} source in view`);
  for (const k of gone) out.push(`${nice(k)} source no longer in view`);
  return out;
}

/** Text the agent receives when a live change should update the plan. */
export function liveChangeMessage(changes: string[]): string {
  return `Live camera: the scene changed (${changes.join("; ")}). Update my plan for this. Device actions still need my approval.`;
}
