import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { HealthProfileSchema, LocationQuerySchema } from "@/lib/domain";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  profile: HealthProfileSchema.optional(),
  location: LocationQuerySchema.optional(),
  userRef: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(8000).optional(),
});

export const POST = route("sessions.create", async ({ req }) => {
  const body = await parseBody(req, Body);
  const runner = getRunner();
  const session = await runner.createSession(body);
  const run = body.message ? await runner.sendMessage(session.id, body.message) : null;
  return NextResponse.json({ sessionId: session.id, location: session.location ?? null, run }, { status: 201 });
});
