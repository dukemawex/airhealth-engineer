import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_PHRASES,
  LIVE_SAM_DEFAULTS,
  cleanRegions,
  conceptsForKeyframe,
  coverTransform,
  decideKeyframe,
  emptySamState,
  initialSamBudget,
  keyframeInterval,
  matchShift,
  patchStats,
  regionAlpha,
  samStateChanges,
  samStateFrom,
  stateChips,
  windowAppearanceChanged,
  type GreyFrame,
  type LiveRegion,
} from "@/lib/liveSam";
import { decideLiveTick, initialLiveState } from "@/lib/liveScene";
import { resetCapabilityCache } from "@/lib/meta/media";

const region = (concept: string, box: [number, number, number, number], confidence = 0.9): LiveRegion => ({
  id: `${concept}-${box.join("-")}`,
  concept,
  label: concept,
  box: { left: box[0], top: box[1], right: box[2], bottom: box[3] },
  confidence,
});

describe("live SAM cadence and cost guard", () => {
  it("follows measured latency within 1.5-4 s", () => {
    expect(keyframeInterval(null)).toBe(1500);
    expect(keyframeInterval(700)).toBe(1500);
    expect(keyframeInterval(2000)).toBe(2400);
    expect(keyframeInterval(9000)).toBe(4000);
  });

  it("sweeps all nine objects on the first and scene-change keyframes, then smoke + a rotating pair", () => {
    expect(conceptsForKeyframe(0, true)).toEqual(LIVE_PHRASES);
    const rot = [1, 2, 3, 4].map((i) => conceptsForKeyframe(i, false));
    for (const r of rot) {
      expect(r).toHaveLength(3);
      expect(r[0]).toBe("smoke");
    }
    // Every non-smoke object comes round within four keyframes.
    expect(new Set(rot.flat())).toEqual(new Set(LIVE_PHRASES));
  });

  it("never overlaps keyframes, respects the cadence, pauses when hidden and stops at the session cap", () => {
    const b = initialSamBudget();
    expect(decideKeyframe(b, 0, { latencyMs: null, sceneChanged: false })).toMatchObject({ send: true, full: true });
    expect(decideKeyframe({ ...b, inFlight: true }, 0, { latencyMs: null, sceneChanged: false })).toEqual({ send: false, reason: "in_flight" });
    expect(decideKeyframe(b, 0, { latencyMs: null, sceneChanged: false, hidden: true })).toEqual({ send: false, reason: "hidden" });
    const after = { ...b, keyframes: 3, samImages: 15, lastSentAt: 10_000 };
    expect(decideKeyframe(after, 11_000, { latencyMs: 800, sceneChanged: false })).toEqual({ send: false, reason: "too_soon" });
    expect(decideKeyframe(after, 11_600, { latencyMs: 800, sceneChanged: false })).toMatchObject({ send: true, full: false });
    expect(decideKeyframe(after, 11_600, { latencyMs: 800, sceneChanged: true })).toMatchObject({ send: true, full: true });
    expect(decideKeyframe(after, 20_000, { latencyMs: 800, sceneChanged: false, fallback: true })).toEqual({ send: false, reason: "too_soon" });
    expect(decideKeyframe({ ...after, keyframes: LIVE_SAM_DEFAULTS.maxKeyframes }, 99_000, { latencyMs: 800, sceneChanged: false })).toEqual({ send: false, reason: "budget_spent" });
    expect(decideKeyframe({ ...after, samImages: LIVE_SAM_DEFAULTS.maxSamImages - 2 }, 99_000, { latencyMs: 800, sceneChanged: false })).toEqual({ send: false, reason: "budget_spent" });
  });

  it("lets a SAM-detected change through the live plan cooldown logic without a luma change", () => {
    const s = { ...initialLiveState(), analyses: 1, lastAnalysisAt: 0 };
    expect(decideLiveTick(s, 30_000, 0.01)).toMatchObject({ analyze: false, reason: "unchanged" });
    expect(decideLiveTick(s, 30_000, 0.01, { force: true })).toMatchObject({ analyze: true });
    expect(decideLiveTick(s, 5_000, 0.01, { force: true })).toMatchObject({ analyze: false, reason: "cooldown" });
  });
});

describe("mask-derived state", () => {
  it("drops weak matches and cross-concept duplicates (purifier beats a look-alike AC match)", () => {
    const kept = cleanRegions([
      region("air purifier", [314, 188, 352, 269], 0.63),
      region("air conditioner", [314, 188, 353, 269], 0.8),
      region("air conditioner", [331, 20, 401, 66], 0.95),
      region("smoke", [0, 0, 10, 10], 0.2),
    ]);
    expect(kept.map((r) => `${r.concept} ${r.confidence}`)).toEqual(["air purifier 0.63", "air conditioner 0.95"]);
  });

  it("builds honest chips: only what was segmented, window change phrased as a question", () => {
    const seg = new Set(["smoke", "window", "air purifier", "person"]);
    const s = samStateFrom([region("window", [1, 1, 5, 5]), region("person", [1, 1, 5, 5])]);
    expect(stateChips(s, seg).map((c) => c.text)).toEqual(["Smoke/haze: none seen", "Window: in view", "Person: in view"]);
    const s2 = samStateFrom([region("window", [1, 1, 5, 5]), region("smoke", [1, 1, 5, 5])], true);
    const chips = stateChips(s2, seg);
    expect(chips[0]).toEqual({ key: "smoke", text: "Smoke/haze: detected", tone: "alert" });
    expect(chips[1]!.text).toBe("Window: changed (opened or closed?)");
  });

  it("reports plan-relevant changes only for concepts segmented in this keyframe", () => {
    const prev = samStateFrom([region("window", [1, 1, 5, 5]), region("air purifier", [1, 1, 5, 5])]);
    const next = samStateFrom([region("window", [1, 1, 5, 5]), region("smoke", [1, 1, 5, 5])], true);
    expect(samStateChanges(prev, next, new Set(["smoke", "window", "fan"]))).toEqual([
      "SAM 3.1: smoke/haze appeared",
      "SAM 3.1: window opened or closed (its outlined area changed)",
    ]);
    // The purifier was not asked about in this keyframe, so it is not "gone".
    expect(samStateChanges(prev, next, new Set(["smoke"]))).toEqual(["SAM 3.1: smoke/haze appeared", "SAM 3.1: window opened or closed (its outlined area changed)"]);
    expect(samStateChanges(prev, emptySamState(), new Set(["air purifier"]))).toEqual(["SAM 3.1: purifier no longer in view"]);
  });
});

describe("tracking between keyframes", () => {
  const frame = (w: number, h: number, sq: { x: number; y: number }): GreyFrame => {
    const data = new Float32Array(w * h).fill(0.2);
    for (let y = sq.y; y < sq.y + 10; y++) for (let x = sq.x; x < sq.x + 14; x++) data[y * w + x] = 0.9 - ((x - sq.x + 2 * (y - sq.y)) % 3) * 0.1;
    return { w, h, data };
  };

  it("finds how far a masked patch moved", () => {
    const ref = frame(64, 48, { x: 20, y: 15 });
    const cur = frame(64, 48, { x: 23, y: 13 });
    const m = matchShift(ref, cur, { left: 18, top: 13, right: 36, bottom: 27 });
    expect({ dx: m.dx, dy: m.dy }).toEqual({ dx: 3, dy: -2 });
    expect(m.error).toBeLessThan(0.01);
    expect(matchShift(ref, ref, { left: 18, top: 13, right: 36, bottom: 27 })).toMatchObject({ dx: 0, dy: 0 });
  });

  it("flags a window whose outlined area changed appearance", () => {
    const closed = frame(64, 48, { x: 20, y: 15 });
    const open = { ...closed, data: closed.data.map((v, i) => (i % 64 >= 20 && i % 64 < 34 && i >= 15 * 64 && i < 25 * 64 ? 0.35 : v)) };
    const box = { left: 20, top: 15, right: 34, bottom: 25 };
    expect(windowAppearanceChanged(patchStats(closed, box), patchStats(closed, box))).toBe(false);
    expect(windowAppearanceChanged(patchStats(closed, box), patchStats(open, box))).toBe(true);
  });

  it("fades outlines with age (no gradual fade under reduced motion) and maps object-fit: cover", () => {
    expect(regionAlpha(1000, false)).toBe(1);
    expect(regionAlpha(9000, false)).toBeLessThan(1);
    expect(regionAlpha(9000, true)).toBe(0.6);
    expect(regionAlpha(20_000, false)).toBe(0);
    expect(coverTransform(640, 480, 400, 400)).toEqual({ scale: 400 / 480, ox: (400 - 640 * (400 / 480)) / 2, oy: 0 });
  });
});

describe("POST /api/vision/live", () => {
  const fixture = readFileSync(new URL("./fixtures/sam-sky.sse", import.meta.url), "utf8");
  const IMG = "data:image/jpeg;base64," + "A".repeat(200);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const MODELS = { data: ["muse-spark-1.3", "sam-3.1"].map((id) => ({ id })) };
  beforeAll(() => {
    Object.assign(process.env, { MODEL_API_KEY: "test-key", META_API_BASE_URL: "https://api.meta.test/v1", API_AUTH_TOKEN: "" });
  });
  beforeEach(() => resetCapabilityCache());
  afterEach(() => vi.unstubAllGlobals());
  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/vision/live/route");
    const req = new NextRequest("http://localhost:3000/api/vision/live", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `t-${Math.random()}` }, body: JSON.stringify(body) });
    return POST(req, { params: Promise.resolve({}) } as never);
  };

  it("segments each concept with SAM 3.1 in parallel (no Muse Spark call) and returns masks + timing", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(String(url));
        if (String(url).endsWith("/models")) return json(MODELS);
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("sam-3.1");
        expect(body.metadata).toEqual({ mask_encoding: "one_bit", include_confidence: "true" });
        return new Response(fixture, { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const res = await post({ image: IMG, width: 640, height: 360, concepts: ["window", "smoke"] });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("sam-3.1");
    expect(data.concepts.sort()).toEqual(["smoke", "window"]);
    expect(data.regions.length).toBeGreaterThan(0);
    expect(data.regions[0].mask.path).toMatch(/^M/);
    expect(typeof data.latencyMs).toBe("number");
    expect(calls.filter((u) => u.endsWith("/responses"))).toHaveLength(2);
    expect(calls.some((u) => u.endsWith("/chat/completions"))).toBe(false);
  });

  it("falls back to labelled Muse Spark grounding boxes when SAM fails, never fake masks", async () => {
    const scene = {
      summary: "Room",
      setting: "indoor",
      visibleHaze: "none",
      hazeEvidence: "clear",
      estimatedVisibilityKm: null,
      pollutionSources: [],
      room: { windows: 1, doors: 0, purifierVisible: false, fanOrAcVisible: false, ventsVisible: false, filterCondition: "not_visible", estimatedFloorAreaM2: null },
      engineeringNotes: [],
      segmentTargets: [],
      boxes: [{ label: "window", x_min: 100, y_min: 100, x_max: 500, y_max: 600 }],
      confidence: "medium",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/models")) return json(MODELS);
        if (u.endsWith("/chat/completions")) return json({ choices: [{ message: { content: JSON.stringify(scene) } }] });
        return json({ error: { message: "overloaded" } }, 503);
      }),
    );
    const res = await post({ image: IMG, width: 500, height: 400, concepts: ["window"], allowFallback: true });
    const data = await res.json();
    expect(data.source).toBe("muse-spark-grounding");
    expect(data.fallbackReason).toMatch(/sam-3.1 failed/);
    expect(data.regions[0]).toMatchObject({ label: "window", box: { left: 50, top: 40, right: 250, bottom: 240 } });
    expect(data.regions[0].mask).toBeUndefined();

    const noFallback = await (await post({ image: IMG, width: 500, height: 400, concepts: ["window"] })).json();
    expect(noFallback.source).toBe("muse-spark-grounding");
    expect(noFallback.regions).toEqual([]);
  });

  it("rejects concepts outside the live list", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await post({ image: IMG, width: 500, height: 400, concepts: ["credit card"] });
    expect(res.status).toBe(400);
  });
});
