import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { transcribeWav } from "@/lib/meta/media";

export const runtime = "nodejs";
export const maxDuration = 40;

/** 16 kHz mono PCM16 is 32 KB/s, so 4 MB is ~2 minutes and stays under Vercel's 4.5 MB body limit. */
const MAX_BYTES = 4_000_000;

/**
 * Push-to-talk audio (WAV body) -> Muse Voice Transcribe -> text.
 * The audio is forwarded in memory and never stored.
 */
export const POST = route("voice.transcribe", async ({ req, log }) => {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new AppError("bad_request", "Recording is too long; keep it under about 2 minutes.");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new AppError("bad_request", "Recording is too long; keep it under about 2 minutes.");
  if (bytes.length < 64) throw new AppError("bad_request", "No audio received.");
  const cfg = getConfig();
  const t0 = Date.now();
  const out = await transcribeWav({ cfg: cfg.meta, logger: log }, bytes);
  return NextResponse.json({ ...out, latencyMs: Date.now() - t0 }, { headers: { "cache-control": "no-store" } });
});
