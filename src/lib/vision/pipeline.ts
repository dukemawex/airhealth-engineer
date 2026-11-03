import type { Logger } from "../logger";
import { META_MODELS, analyzeScene, getCapabilities, overlayFromGrounding, segmentImage, type MediaDeps } from "../meta/media";
import type { OverlayRegion, SceneAnalysis, SceneOverlay, VisionResult } from "./scene";

/** Pick what SAM 3.1 should outline: model-suggested targets first, then sensible defaults. */
export function chooseSegmentTargets(a: SceneAnalysis, max = 2): string[] {
  const out = [...a.segmentTargets];
  if (a.visibleHaze !== "none" && a.visibleHaze !== "unclear" && !out.some((t) => /haze|smog|smoke/.test(t))) out.unshift("haze");
  if (a.room.windows > 0 && !out.includes("window")) out.push("window");
  if (a.room.purifierVisible && !out.includes("air purifier")) out.push("air purifier");
  return [...new Set(out)].slice(0, max);
}

/**
 * Photo -> Muse Spark structured analysis -> SAM 3.1 outlines (in parallel per
 * target). Falls back to Muse Spark's own grounding boxes when SAM is
 * unavailable, errors, or finds nothing.
 */
export async function runVisionPipeline(
  deps: MediaDeps & { logger: Logger },
  input: { imageDataUrl: string; width: number; height: number; note?: string; place?: string },
): Promise<VisionResult> {
  const caps = await getCapabilities(deps);
  const t0 = Date.now();
  const { analysis, model } = await analyzeScene(deps, input);
  const visionMs = Date.now() - t0;

  let overlay: SceneOverlay;
  let segmentationMs: number | null = null;
  const targets = chooseSegmentTargets(analysis);
  if (!caps.features.segmentation) {
    overlay = overlayFromGrounding(analysis, input.width, input.height, caps.reachable ? "sam-3.1 not listed for this key" : "model list unreachable");
  } else if (!targets.length) {
    overlay = overlayFromGrounding(analysis, input.width, input.height, "nothing to segment");
  } else {
    const t1 = Date.now();
    const settled = await Promise.allSettled(targets.map((phrase) => segmentImage(deps, { imageDataUrl: input.imageDataUrl, phrase, maxRegions: 4 })));
    segmentationMs = Date.now() - t1;
    const regions: OverlayRegion[] = [];
    const errors: string[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") regions.push(...s.value.regions);
      else errors.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
    }
    if (errors.length) deps.logger.warn("sam segmentation partial failure", { errors: errors.slice(0, 2) });
    overlay = regions.length
      ? { source: "sam-3.1", width: input.width, height: input.height, regions: regions.slice(0, 8) }
      : overlayFromGrounding(analysis, input.width, input.height, errors.length ? `sam-3.1 failed: ${errors[0]!.slice(0, 120)}` : "sam-3.1 found no matches");
  }
  return {
    analysis,
    overlay,
    models: { vision: model, segmentation: overlay.source === "sam-3.1" ? META_MODELS.segmentation : null },
    timings: { visionMs, segmentationMs },
  };
}
