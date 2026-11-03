import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { sessionToUIMessages, streamAgentRun } from "@/lib/agent/uiStream";
import { HealthProfileSchema, LocationQuerySchema } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Chat endpoint for the Vercel AI SDK `useChat` hook.
 * The client sends only the new user text plus a conversation id; the full
 * conversation memory lives server-side in the session store.
 */
const Body = z
  .object({
    conversationId: z.string().trim().min(1).max(100).optional(),
    message: z.string().trim().min(1).max(8000).optional(),
    resume: z.boolean().optional(),
    location: LocationQuerySchema.optional(),
    profile: HealthProfileSchema.optional(),
  })
  .refine((b) => Boolean(b.message) !== Boolean(b.resume), { message: "Provide exactly one of message or resume" });

export const POST = route("agent.stream", async ({ req, log, requestId }) => {
  const body = await parseBody(req, Body);
  const runner = getRunner();
  let conversationId = body.conversationId;

  if (!conversationId) {
    const session = await runner.createSession({ location: body.location, profile: body.profile });
    conversationId = session.id;
  } else {
    const session = await runner.getSession(conversationId);
    if (session.pendingTurn || session.status === "awaiting_approval") {
      throw new AppError("conflict", "This conversation is waiting for your approval decision. Accept or reject the pending device action first.", {
        pendingApprovalIds: session.pendingTurn?.approvalIds ?? [],
      });
    }
    if (body.location || body.profile) await runner.updateContext(conversationId, { location: body.location, profile: body.profile });
  }

  const id = conversationId;
  return streamAgentRun({
    log: log.child({ sessionId: id }),
    conversationId: id,
    headers: { "x-request-id": requestId, "x-conversation-id": id },
    run: (events) => (body.resume ? runner.resume(id, events) : runner.sendMessage(id, body.message!, events)),
  });
});

/** Load a conversation (UI messages + live status) to restore the chat after reload. */
export const GET = route("agent.load", async ({ req }) => {
  const conversationId = req.nextUrl.searchParams.get("conversationId");
  if (!conversationId) throw new AppError("bad_request", "conversationId query parameter is required");
  const runner = getRunner();
  const session = await runner.getSession(conversationId);
  const approvals = await runner.listApprovals(conversationId);
  const status = await runner.status(conversationId);
  return NextResponse.json({ conversationId, messages: sessionToUIMessages(session, approvals), status });
});
