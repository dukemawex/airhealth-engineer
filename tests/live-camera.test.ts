import { describe, expect, it } from "vitest";
import { decideLiveTick, frameDiff, initialLiveState, LIVE_DEFAULTS, liveChangeMessage, lumaSignature, sceneChanges } from "@/lib/liveScene";
import { FixedWindowLimiter } from "@/lib/rateLimit";
import type { SceneAnalysis } from "@/lib/vision/scene";

const scene = (over: Partial<SceneAnalysis> = {}, room: Partial<SceneAnalysis["room"]> = {}): SceneAnalysis => ({
  summary: "Bedroom",
  setting: "indoor",
  visibleHaze: "none",
  hazeEvidence: "",
  estimatedVisibilityKm: null,
  pollutionSources: [],
  room: { windows: 1, doors: 1, purifierVisible: true, fanOrAcVisible: false, ventsVisible: false, filterCondition: "clean", estimatedFloorAreaM2: 12, ...room },
  engineeringNotes: [],
  segmentTargets: [],
  boxes: [],
  confidence: "medium",
  ...over,
});

const flat = (v: number, n = 16) => Float32Array.from({ length: n }, () => v);

describe("live camera change detection", () => {
  it("computes luma and ignores a pure exposure shift", () => {
    const sig = lumaSignature([255, 255, 255, 255, 0, 0, 0, 255], 2);
    expect(sig[0]).toBeCloseTo(1, 5);
    expect(sig[1]).toBe(0);
    expect(frameDiff(flat(0.3), flat(0.5))).toBeCloseTo(0, 6);
    const a = flat(0.3);
    const b = flat(0.3);
    for (let i = 0; i < 8; i++) b[i] = 0.9; // half the frame changes (window opened, person moves)
    expect(frameDiff(a, b)).toBeGreaterThan(LIVE_DEFAULTS.changeThreshold);
    expect(frameDiff([], [])).toBe(1);
  });

  it("only spends a vision call on baseline or real change, with cooldown and a hard budget", () => {
    const s = initialLiveState();
    expect(decideLiveTick(s, 0, null)).toEqual({ analyze: true, reason: "baseline" });
    expect(decideLiveTick({ ...s, inFlight: true }, 0, 0.5).reason).toBe("in_flight");
    expect(decideLiveTick({ ...s, analyses: 1, lastAnalysisAt: 0 }, 60_000, 0.01).reason).toBe("unchanged");
    expect(decideLiveTick({ ...s, analyses: 1, lastAnalysisAt: 0 }, 5_000, 0.5).reason).toBe("cooldown");
    expect(decideLiveTick({ ...s, analyses: 1, lastAnalysisAt: 0 }, 30_000, 0.5)).toEqual({ analyze: true, reason: "scene_changed" });
    expect(decideLiveTick({ ...s, analyses: LIVE_DEFAULTS.maxAnalyses }, 1e9, 0.9).reason).toBe("budget_spent");
    expect(decideLiveTick(s, 0, null, { blocked: true }).reason).toBe("blocked");
  });

  it("reports only plan-relevant scene changes", () => {
    expect(sceneChanges(scene(), scene())).toEqual([]);
    const c = sceneChanges(
      scene(),
      scene({ visibleHaze: "light", pollutionSources: [{ name: "stove", kind: "cooking", note: "" }] }, { windows: 2, purifierVisible: false }),
    );
    expect(c).toContain("more open windows in view (1 → 2): window opened?");
    expect(c).toContain("visible haze none → light");
    expect(c).toContain("purifier no longer in view");
    expect(c).toContain("new cooking source in view");
    expect(sceneChanges(scene({}, { filterCondition: "dirty" }), scene({}, { filterCondition: "not_visible" }))).toEqual([]);
    const msg = liveChangeMessage(c);
    expect(msg).toMatch(/^Live camera: the scene changed/);
    expect(msg).toMatch(/still need my approval/);
  });

  it("server-side limiter caps live reads per window", () => {
    const l = new FixedWindowLimiter(2, 1000);
    expect(l.take("a", 0)).toBe(true);
    expect(l.take("a", 10)).toBe(true);
    expect(l.take("a", 20)).toBe(false);
    expect(l.take("b", 20)).toBe(true);
    expect(l.take("a", 1000)).toBe(true);
  });
});
