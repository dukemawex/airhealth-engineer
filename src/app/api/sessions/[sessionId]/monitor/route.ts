import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({ force: z.boolean().optional() });

/**
 * Re-check air quality for one conversation. Muse Spark decides whether the change
 * is worth a notification. Called by the UI poll; throttled by MONITOR_MIN_INTERVAL_MINUTES
 * unless force=true.
 */
export const POST = route<{ sessionId: string }>("sessions.monitor", async ({ req, params }) => {
  const body = await parseBody(req, Body);
  const result = await getRunner().monitor(params.sessionId, { force: body.force });
  return NextResponse.json(result);
});
