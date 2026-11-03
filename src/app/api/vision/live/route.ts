import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { LIVE_PHRASES } from "@/lib/liveSam";
import { FixedWindowLimiter } from "@/lib/rateLimit";
import { segmentLiveFrame } from "@/lib/vision/live";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Keyframes are ~512 px JPEGs (30-80 KB); 600 KB of base64 is plenty. */
const MAX_DATA_URL = 600_000;

const Body = z.object({
  image: z.string().min(64).max(MAX_DATA_URL),
  width: z.number().int().min(16).max(1024),
  height: z.number().int().min(16).max(1024),
  concepts: z.array(z.enum(LIVE_PHRASES as [string, ...string[]])).min(1).max(LIVE_PHRASES.length),
  /** Allow a (slow) Muse Spark grounding read if SAM 3.1 is unavailable. */
  allowFallback: z.boolean().optional(),
});

/**
 * Cost guard per client per instance: 300 keyframes and 900 SAM images per
 * 10 minutes (~$2.25 at $2.50 / 1,000 images); the client caps a session at
 * 120 keyframes / 400 images and pauses when the tab is hidden.
 */
const keyframeLimiter = new FixedWindowLimiter(300, 10 * 60_000);
const imageLimiter = new FixedWindowLimiter(900, 10 * 60_000);
const fallbackLimiter = new FixedWindowLimiter(30, 10 * 60_000);

/** Live camera keyframe -> SAM 3.1 masks for the outline overlay. Images are processed in memory, never stored. */
export const POST = route("vision.live", async ({ req, log }) => {
  const body = await parseBody(req, Body);
  const client = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!keyframeLimiter.take(client)) throw new AppError("rate_limited", "Live outline limit reached (300 keyframes per 10 minutes). Outlines paused.");
  for (let i = 0; i < body.concepts.length; i++) {
    if (!imageLimiter.take(client)) throw new AppError("rate_limited", "Live outline limit reached (SAM image budget for 10 minutes). Outlines paused.");
  }
  const allowFallback = !!body.allowFallback && fallbackLimiter.take(client);
  const cfg = getConfig();
  const result = await segmentLiveFrame(
    { cfg: cfg.meta, logger: log },
    { imageDataUrl: body.image, width: body.width, height: body.height, concepts: body.concepts, allowFallback },
  );
  log.info("live keyframe", { source: result.source, concepts: result.concepts.length, regions: result.regions.length, latencyMs: result.latencyMs });
  return NextResponse.json(result, { headers: { "cache-control": "no-store", "server-timing": `sam;dur=${result.latencyMs}` } });
});
