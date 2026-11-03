import { NextResponse } from "next/server";
import { parseBody, route } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { generateImage } from "@/lib/meta/media";
import { ShareInputSchema, sharePrompt } from "@/lib/share/card";

export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * Muse Image background art for the shareable "air today" card. The client
 * composites the exact live numbers on top and only shares via the user's own
 * share sheet or a download. Nothing is posted or stored server-side.
 * On any Muse Image failure the client draws a brand gradient instead.
 */
export const POST = route("share.art", async ({ req, log }) => {
  const input = await parseBody(req, ShareInputSchema);
  const cfg = getConfig();
  const t0 = Date.now();
  try {
    const img = await generateImage({ cfg: cfg.meta, logger: log }, sharePrompt(input));
    return NextResponse.json(
      { image: `data:image/${img.format};base64,${img.b64}`, model: img.model, latencyMs: Date.now() - t0, fallback: false },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    log.warn("muse image unavailable, client will use gradient", { error: err });
    return NextResponse.json(
      { image: null, model: null, latencyMs: Date.now() - t0, fallback: true, reason: err instanceof Error ? err.message.slice(0, 160) : "image error" },
      { headers: { "cache-control": "no-store" } },
    );
  }
});
