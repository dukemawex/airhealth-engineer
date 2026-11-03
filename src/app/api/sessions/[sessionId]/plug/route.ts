import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { PlugSettingsSchema } from "@/lib/devices";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };

/** Smart plug for this conversation: status only, never the auth key. */
export const GET = route<{ sessionId: string }>("plug.get", async ({ params }) =>
  NextResponse.json(await getRunner().plugInfo(params.sessionId), noStore),
);

/** Save plug settings. Saving never switches the plug; only an approved action does. */
export const PUT = route<{ sessionId: string }>("plug.set", async ({ req, params }) => {
  const body = await parseBody(req, PlugSettingsSchema);
  return NextResponse.json(await getRunner().setPlug(params.sessionId, body), noStore);
});

export const DELETE = route<{ sessionId: string }>("plug.clear", async ({ params }) =>
  NextResponse.json(await getRunner().setPlug(params.sessionId, null), noStore),
);

/** Read-only connection check (reads state; does not toggle). */
export const POST = route<{ sessionId: string }>("plug.check", async ({ req, params }) => {
  await parseBody(req, z.object({ check: z.literal(true) }));
  return NextResponse.json(await getRunner().checkPlugConnection(params.sessionId), noStore);
});
