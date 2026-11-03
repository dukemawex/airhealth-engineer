import type { Logger } from "../logger";
import { analyzeScene, getCapabilities, overlayFromGrounding, segmentImage, type MediaDeps } from "../meta/media";
import { LIVE_PHRASES, cleanRegions, conceptFor, type LiveRegion } from "../liveSam";

export interface LiveSegmentResult {
  source: "sam-3.1" | "muse-spark-grounding";
  width: number;
  height: number;
  /** Concepts SAM was asked for in this keyframe (empty in fallback mode). */
  concepts: string[];
  regions: LiveRegion[];
  /** Server-side time spent in SAM (or in the fallback), ms. */
  latencyMs: number;
  perConcept: { concept: string; ms: number; regions: number; error?: string }[];
  /** Why SAM 3.1 was not used, when the source is the fallback. */
  fallbackReason?: string;
}

/**
 * One live keyframe -> SAM 3.1, one concept per request in parallel (the API
 * takes one noun phrase per request). No Muse Spark call on the happy path,
 * which keeps a keyframe around a second. If SAM is unavailable or every
 * request fails, and the caller allows it, Muse Spark's grounding boxes are
 * returned instead, labelled as such.
 */
export async function segmentLiveFrame(
  deps: MediaDeps & { logger: Logger },
  input: { imageDataUrl: string; width: number; height: number; concepts: string[]; allowFallback: boolean },
): Promise<LiveSegmentResult> {
  const concepts = [...new Set(input.concepts.filter((c) => LIVE_PHRASES.includes(c)))];
  const t0 = Date.now();
  const caps = await getCapabilities(deps);
  let reason: string;
  const perConcept: LiveSegmentResult["perConcept"] = [];
  if (caps.features.segmentation) {
    const settled = await Promise.allSettled(
      concepts.map(async (phrase) => {
        const t = Date.now();
        try {
          const r = await segmentImage(deps, { imageDataUrl: input.imageDataUrl, phrase, maxRegions: 4, includeConfidence: true, timeoutMs: 6_000 });
          perConcept.push({ concept: phrase, ms: Date.now() - t, regions: r.regions.length });
          return { phrase, regions: r.regions };
        } catch (err) {
          perConcept.push({ concept: phrase, ms: Date.now() - t, regions: 0, error: err instanceof Error ? err.message.slice(0, 120) : "failed" });
          throw err;
        }
      }),
    );
    const ok = settled.filter((s) => s.status === "fulfilled");
    if (ok.length > 0) {
      const regions: LiveRegion[] = [];
      for (const s of ok) {
        const { phrase, regions: rs } = s.value;
        const c = conceptFor(phrase);
        for (const r of rs) regions.push({ id: r.id, concept: phrase, label: c?.label ?? phrase, box: r.box, mask: r.mask, confidence: r.confidence });
      }
      return {
        source: "sam-3.1",
        width: input.width,
        height: input.height,
        concepts: ok.map((s) => s.value.phrase),
        regions: cleanRegions(regions),
        latencyMs: Date.now() - t0,
        perConcept,
      };
    }
    const first = settled.find((s) => s.status === "rejected");
    reason = `sam-3.1 failed: ${first && first.status === "rejected" && first.reason instanceof Error ? first.reason.message.slice(0, 120) : "no response"}`;
    deps.logger.warn("live sam keyframe failed", { reason });
  } else {
    reason = caps.reachable ? "sam-3.1 not listed for this key" : "model list unreachable";
  }
  if (!input.allowFallback) {
    return { source: "muse-spark-grounding", width: input.width, height: input.height, concepts: [], regions: [], latencyMs: Date.now() - t0, perConcept, fallbackReason: `${reason} (fallback read skipped: too soon)` };
  }
  const { analysis } = await analyzeScene(deps, { imageDataUrl: input.imageDataUrl });
  const ov = overlayFromGrounding(analysis, input.width, input.height, reason);
  return {
    source: "muse-spark-grounding",
    width: input.width,
    height: input.height,
    concepts: [],
    regions: ov.regions.map((r) => ({ id: r.id, concept: r.label.toLowerCase(), label: r.label, box: r.box })),
    latencyMs: Date.now() - t0,
    perConcept,
    fallbackReason: reason,
  };
}
