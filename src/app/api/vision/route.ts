import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { runVisionPipeline } from "@/lib/vision/pipeline";

export const runtime = "nodejs";
export const maxDuration = 90;

/** ~3.4 MB of base64 keeps the request under Vercel's 4.5 MB body limit. */
const MAX_DATA_URL = 3_600_000;

const Body = z.object({
  image: z.string().min(64).max(MAX_DATA_URL),
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
  note: z.string().trim().max(500).optional(),
  place: z.string().trim().max(120).optional(),
});

/**
 * Photo or video frame -> Muse Spark image understanding (json_schema) ->
 * SAM 3.1 outlines. The image is processed in memory and never stored.
 */
export const POST = route("vision.analyze", async ({ req, log }) => {
  const body = await parseBody(req, Body);
  const cfg = getConfig();
  const result = await runVisionPipeline(
    { cfg: cfg.meta, logger: log },
    { imageDataUrl: body.image, width: body.width, height: body.height, note: body.note, place: body.place },
  );
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
});
