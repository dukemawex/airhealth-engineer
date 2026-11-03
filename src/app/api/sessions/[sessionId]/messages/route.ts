import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({ message: z.string().trim().min(1).max(8000) });

export const POST = route<{ sessionId: string }>("sessions.message", async ({ req, params }) => {
  const { message } = await parseBody(req, Body);
  const run = await getRunner().sendMessage(params.sessionId, message);
  return NextResponse.json(run);
});
