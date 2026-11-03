"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { apiFetch } from "@/lib/client/api";
import {
  LIVE_SAM_DEFAULTS,
  SAM_IMAGE_USD,
  cleanRegions,
  conceptFor,
  coverTransform,
  decideKeyframe,
  emptySamState,
  greyFromRgba,
  initialSamBudget,
  iou,
  matchShift,
  patchStats,
  regionAlpha,
  samStateChanges,
  samStateFrom,
  stateChips,
  windowAppearanceChanged,
  type GreyFrame,
  type LiveRegion,
  type SamSceneState,
  type StateChip,
} from "@/lib/liveSam";
import { frameDiff, lumaSignature } from "@/lib/liveScene";
import type { LiveSegmentResult } from "@/lib/vision/live";

/** A SAM region plus where it has moved since its keyframe (grey-frame px). */
interface Tracked extends LiveRegion {
  source: LiveSegmentResult["source"];
  kw: number;
  kh: number;
  ref: GreyFrame;
  refBox: { left: number; top: number; right: number; bottom: number };
  dx: number;
  dy: number;
  lost: boolean;
  confirmedAt: number;
  path?: Path2D;
}

interface Hud {
  source: LiveSegmentResult["source"] | null;
  fallbackReason?: string;
  latencyMs: number | null;
  samMs: number | null;
  segPerSec: number;
  objects: number;
  keyframes: number;
  samImages: number;
  chips: StateChip[];
  status: string;
}

const GREY_W = 128;
const THUMB_W = 32;
const THUMB_H = 24;

/**
 * Real SAM 3.1 masks drawn over the live <video>. Keyframes go to
 * /api/vision/live every ~1.5 s (cadence follows measured latency, capped per
 * session); between keyframes each mask is moved by template matching on a
 * 128-px grey frame and fades with age. Nothing is drawn that SAM (or, when
 * SAM is unavailable, a clearly labelled Muse Spark grounding box) did not return.
 */
export function LiveSamOverlay({
  videoRef,
  mirrored,
  onChanges,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  mirrored: boolean;
  /** Plan-relevant state changes derived from the masks (e.g. "SAM 3.1: smoke/haze appeared"). */
  onChanges?: (changes: string[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onChangesRef = useRef(onChanges);
  const mirroredRef = useRef(mirrored);
  useEffect(() => {
    onChangesRef.current = onChanges;
    mirroredRef.current = mirrored;
  }, [onChanges, mirrored]);
  const [hud, setHud] = useState<Hud>({
    source: null,
    latencyMs: null,
    samMs: null,
    segPerSec: 0,
    objects: 0,
    keyframes: 0,
    samImages: 0,
    chips: [],
    status: "Starting SAM 3.1 outlines…",
  });
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let cancelled = false;
    let raf = 0;
    let budget = initialSamBudget();
    let latency: number | null = null;
    let fallback = false;
    let paused = false;
    let regions: Tracked[] = [];
    let lastSig: Float32Array | null = null;
    let state: SamSceneState = emptySamState();
    const segmented = new Set<string>();
    let windowBase: { box: Tracked["refBox"]; stats: { mean: number; std: number } } | null = null;
    let windowChangedUntil = 0;
    const doneAt: number[] = [];

    const grey = document.createElement("canvas");
    const gctx = grey.getContext("2d", { willReadFrequently: true });
    const thumb = document.createElement("canvas");
    thumb.width = THUMB_W;
    thumb.height = THUMB_H;
    const tctx = thumb.getContext("2d", { willReadFrequently: true });
    const key = document.createElement("canvas");
    const kctx = key.getContext("2d");

    const readGrey = (v: HTMLVideoElement): GreyFrame | null => {
      if (!gctx) return null;
      const gh = Math.max(8, Math.round((GREY_W * v.videoHeight) / v.videoWidth));
      if (grey.width !== GREY_W || grey.height !== gh) {
        grey.width = GREY_W;
        grey.height = gh;
      }
      gctx.drawImage(v, 0, 0, GREY_W, gh);
      return greyFromRgba(gctx.getImageData(0, 0, GREY_W, gh).data, GREY_W, gh);
    };
    const readSig = (v: HTMLVideoElement) => {
      if (!tctx) return null;
      tctx.drawImage(v, 0, 0, THUMB_W, THUMB_H);
      return lumaSignature(tctx.getImageData(0, 0, THUMB_W, THUMB_H).data, THUMB_W * THUMB_H);
    };

    const track = (cur: GreyFrame) => {
      for (const r of regions) {
        if (r.source !== "sam-3.1") continue;
        const m = matchShift(r.ref, cur, r.refBox, { dx: r.dx, dy: r.dy }, 4);
        r.lost = m.error > 0.14;
        if (!r.lost) {
          r.dx = m.dx;
          r.dy = m.dy;
        }
      }
    };

    const sendKeyframe = async (v: HTMLVideoElement, concepts: string[], full: boolean) => {
      if (!kctx) return;
      const kw = Math.min(LIVE_SAM_DEFAULTS.keyframeWidth, v.videoWidth);
      const kh = Math.round((kw * v.videoHeight) / v.videoWidth);
      key.width = kw;
      key.height = kh;
      kctx.drawImage(v, 0, 0, kw, kh);
      const ref = readGrey(v);
      const sig = readSig(v);
      if (!ref) return;
      const image = key.toDataURL("image/jpeg", 0.72);
      budget = { ...budget, inFlight: true, lastSentAt: Date.now(), keyframes: budget.keyframes + 1, samImages: budget.samImages + concepts.length };
      const t0 = performance.now();
      try {
        const r = await apiFetch<LiveSegmentResult>("/api/vision/live", {
          method: "POST",
          body: JSON.stringify({ image, width: kw, height: kh, concepts, allowFallback: true }),
        });
        if (cancelled) return;
        const rtt = Math.round(performance.now() - t0);
        latency = latency === null ? rtt : Math.round(latency * 0.6 + rtt * 0.4);
        const now = Date.now();
        doneAt.push(now);
        while (doneAt.length && now - doneAt[0]! > 10_000) doneAt.shift();
        lastSig = sig;
        const toGrey = GREY_W / kw;
        const fresh = (rr: LiveRegion): Tracked => ({
          ...rr,
          source: r.source,
          kw,
          kh,
          ref,
          refBox: { left: rr.box.left * toGrey, top: rr.box.top * toGrey, right: rr.box.right * toGrey, bottom: rr.box.bottom * toGrey },
          dx: 0,
          dy: 0,
          lost: false,
          confirmedAt: now,
          path: rr.mask ? new Path2D(rr.mask.path) : undefined,
        });
        if (r.source === "sam-3.1") {
          fallback = false;
          const asked = new Set(r.concepts);
          regions = cleanRegions([...r.regions.map(fresh), ...regions.filter((x) => x.source === "sam-3.1" && !asked.has(x.concept))]);
          for (const c of r.concepts) segmented.add(c);
          // Catch up with motion that happened while SAM was working.
          const cur = readGrey(v);
          if (cur) track(cur);
          // Window state heuristic: compare the outlined window area with how it looked when first outlined.
          let windowChanged = now < windowChangedUntil;
          if (asked.has("window")) {
            const w = r.regions.filter((x) => x.concept === "window").map(fresh)[0];
            if (!w) windowBase = null;
            else {
              const stats = patchStats(ref, w.refBox);
              if (windowBase && iou(windowBase.box, w.refBox) > 0.6 && !full) {
                if (windowAppearanceChanged(windowBase.stats, stats)) {
                  windowChanged = true;
                  windowChangedUntil = now + 20_000;
                  windowBase = { box: w.refBox, stats };
                }
              } else windowBase = { box: w.refBox, stats };
            }
          }
          const next = samStateFrom(regions, windowChanged);
          const changes = budget.keyframes > 1 ? samStateChanges(state, next, asked) : [];
          state = next;
          if (changes.length) {
            setAnnounce(changes.map((c) => c.replace(/^SAM 3\.1: /, "")).join("; "));
            onChangesRef.current?.(changes);
          }
        } else if (r.regions.length || !regions.some((x) => x.source === "muse-spark-grounding")) {
          fallback = true;
          regions = r.regions.map(fresh);
          state = emptySamState();
        } else fallback = true;
        setHud({
          source: r.source,
          fallbackReason: r.fallbackReason,
          latencyMs: latency,
          samMs: r.latencyMs,
          segPerSec: doneAt.length / 10,
          objects: regions.length,
          keyframes: budget.keyframes,
          samImages: budget.samImages,
          chips: r.source === "sam-3.1" ? stateChips(state, segmented) : [],
          status: full ? "Full sweep: all 9 objects" : `Refreshed: ${r.concepts.map((c) => conceptFor(c)?.label ?? c).join(", ")}`,
        });
      } catch (err) {
        if (cancelled) return;
        const m = err instanceof Error ? err.message : "SAM keyframe failed";
        if (/limit|429/i.test(m)) paused = true;
        setHud((h) => ({ ...h, status: paused ? `Paused: ${m}` : `Keyframe failed: ${m}` }));
      } finally {
        budget = { ...budget, inFlight: false };
      }
    };

    const draw = () => {
      const v = videoRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!v || !v.videoWidth) return;
      const { scale, ox, oy } = coverTransform(v.videoWidth, v.videoHeight, W, H);
      const now = Date.now();
      const mir = mirroredRef.current;
      regions = regions.filter((r) => regionAlpha(now - r.confirmedAt, reduced) > 0);
      ctx.font = "600 12px system-ui, sans-serif";
      for (const r of regions) {
        const c = conceptFor(r.concept);
        const colour = c?.colour ?? "#e2e8f0";
        const alpha = regionAlpha(now - r.confirmedAt, reduced) * (r.lost ? 0.5 : 1);
        const kv = v.videoWidth / r.kw;
        const s = scale * kv;
        const dxk = (r.dx * r.kw) / GREY_W;
        const dyk = (r.dy * r.kw) / GREY_W;
        const left = ox + s * (r.box.left + dxk);
        const right = ox + s * (r.box.right + dxk);
        const top = oy + s * (r.box.top + dyk);
        const bottom = oy + s * (r.box.bottom + dyk);
        const sx0 = mir ? W - right : left;
        const sx1 = mir ? W - left : right;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colour;
        ctx.fillStyle = colour;
        if (r.path && r.mask) {
          const bw = Math.max(1, r.box.right - r.box.left);
          const bh = Math.max(1, r.box.bottom - r.box.top);
          const a = (s * bw) / r.mask.width;
          const d = (s * bh) / r.mask.height;
          ctx.setTransform(dpr * (mir ? -a : a), 0, 0, dpr * d, dpr * (mir ? W - left : left), dpr * top);
          ctx.globalAlpha = alpha * 0.32;
          ctx.fill(r.path, "evenodd");
          ctx.globalAlpha = alpha;
          ctx.lineWidth = 2 / Math.sqrt(Math.abs(a * d));
          ctx.stroke(r.path);
        } else {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 2;
          ctx.globalAlpha = alpha * 0.12;
          ctx.fillRect(sx0, top, sx1 - sx0, bottom - top);
          ctx.globalAlpha = alpha;
          ctx.strokeRect(sx0, top, sx1 - sx0, bottom - top);
          ctx.setLineDash([]);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const text = r.source === "sam-3.1" ? `${r.label}${r.confidence !== undefined ? ` ${Math.round(r.confidence * 100)}%` : ""}` : `${r.label} · grounding box`;
        const tw = ctx.measureText(text).width + 12;
        const lx = Math.max(2, Math.min(W - tw - 2, sx0));
        const ly = Math.max(2, top - 22 >= 2 ? top - 22 : top + 2);
        ctx.globalAlpha = Math.max(0.5, alpha);
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.roundRect(lx, ly, tw, 20, 6);
        ctx.fill();
        ctx.fillStyle = "#0b1215";
        ctx.fillText(text, lx + 6, ly + 14);
      }
      ctx.globalAlpha = 1;
    };

    let lastTrack = 0;
    let lastDecide = 0;
    const loop = (t: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      if (!v || !v.videoWidth || document.hidden) return;
      // Tracking: ~10 Hz (2 Hz with reduced motion, so outlines step instead of glide).
      if (t - lastTrack > (reduced ? 500 : 100) && regions.length) {
        lastTrack = t;
        const cur = readGrey(v);
        if (cur) track(cur);
      }
      if (t - lastDecide > 250 && !paused) {
        lastDecide = t;
        const sig = readSig(v);
        const sceneChanged = !!(sig && lastSig && frameDiff(lastSig, sig) > LIVE_SAM_DEFAULTS.sceneChangeThreshold);
        const d = decideKeyframe(budget, Date.now(), { latencyMs: latency, sceneChanged, hidden: document.hidden, fallback });
        if (d.send) void sendKeyframe(v, d.concepts, d.full);
        else if (d.reason === "budget_spent") {
          paused = true;
          setHud((h) => ({ ...h, status: `Paused: session cap reached (${LIVE_SAM_DEFAULTS.maxKeyframes} keyframes / ${LIVE_SAM_DEFAULTS.maxSamImages} SAM images). Turn Outlines off and on to continue.` }));
          setAnnounce("Outlines paused: session cap reached.");
        }
      }
      draw();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [videoRef]);

  const cost = (hud.samImages * SAM_IMAGE_USD).toFixed(2);
  return (
    <>
      <canvas ref={canvasRef} className="sam-canvas" aria-hidden="true" data-testid="sam-canvas" />
      <div className="sam-hud" data-testid="sam-hud" data-source={hud.source ?? "pending"}>
        {hud.source === "muse-spark-grounding" ? (
          <p className="sam-hud-line sam-hud-fallback">
            <strong>Fallback: Muse Spark grounding boxes</strong> · SAM 3.1 unavailable{hud.fallbackReason ? ` (${hud.fallbackReason})` : ""}
          </p>
        ) : (
          <p className="sam-hud-line">
            <strong>SAM 3.1</strong>
            <span>{hud.segPerSec.toFixed(1)} seg/s</span>
            <span>{hud.latencyMs !== null ? `${hud.latencyMs} ms` : "– ms"}</span>
            <span>
              {hud.objects} object{hud.objects === 1 ? "" : "s"}
            </span>
          </p>
        )}
        {hud.chips.length > 0 && (
          <ul className="sam-chips" aria-label="What SAM 3.1 outlines show">
            {hud.chips.map((c) => (
              <li key={c.key} data-tone={c.tone}>
                {c.text}
              </li>
            ))}
          </ul>
        )}
        <p className="sam-hud-meta" title="Keyframes are still images; SAM 3.1's video tracking needs an uploaded clip, so outlines are tracked on-device between keyframes.">
          {hud.status} · {hud.keyframes}/{LIVE_SAM_DEFAULTS.maxKeyframes} keyframes · ~${cost}
        </p>
      </div>
      <p className="sr-only" aria-live="polite" role="status">
        {announce}
      </p>
    </>
  );
}
