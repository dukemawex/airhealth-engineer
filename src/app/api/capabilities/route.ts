import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { META_MODELS, getCapabilities } from "@/lib/meta/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which Meta Model API features are live for this deployment (from GET /v1/models, cached 10 min). */
export const GET = route(
  "capabilities",
  async ({ log }) => {
    const cfg = getConfig();
    const caps = cfg.meta.apiKey
      ? await getCapabilities({ cfg: cfg.meta, logger: log })
      : { checkedAt: new Date().toISOString(), reachable: false, models: [], features: { agent: false, vision: false, segmentation: false, transcribe: false, image: false }, error: "MODEL_API_KEY not set" };
    return NextResponse.json(
      { ...caps, modelIds: { ...META_MODELS, agent: cfg.meta.modelId, vision: cfg.meta.modelId } },
      { headers: { "cache-control": "no-store" } },
    );
  },
  { auth: false },
);
