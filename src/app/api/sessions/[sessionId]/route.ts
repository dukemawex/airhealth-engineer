import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { HealthProfileSchema, LocationQuerySchema } from "@/lib/domain";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";

export const GET = route<{ sessionId: string }>("sessions.get", async ({ params }) => {
  const s = await getRunner().getSession(params.sessionId);
  return NextResponse.json({
    id: s.id,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    location: s.location ?? null,
    profile: s.profile ?? null,
    lastError: s.lastError ?? null,
    pendingApprovalIds: s.pendingTurn?.approvalIds ?? [],
    messages: s.messages,
  });
});

const PatchBody = z
  .object({
    location: LocationQuerySchema.optional(),
    profile: HealthProfileSchema.optional(),
    replaceProfile: z.boolean().optional(),
  })
  .refine((b) => b.location || b.profile, { message: "Provide location and/or profile" });

/** Update the conversation's location (geocoded) and/or health profile without a chat turn. */
export const PATCH = route<{ sessionId: string }>("sessions.update", async ({ req, params }) => {
  const body = await parseBody(req, PatchBody);
  const s = await getRunner().updateContext(params.sessionId, body);
  return NextResponse.json({ id: s.id, location: s.location ?? null, profile: s.profile ?? null, updatedAt: s.updatedAt });
});
