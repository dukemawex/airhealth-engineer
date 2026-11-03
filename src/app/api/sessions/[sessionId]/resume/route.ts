import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = route<{ sessionId: string }>("sessions.resume", async ({ params }) => {
  return NextResponse.json(await getRunner().resume(params.sessionId));
});
