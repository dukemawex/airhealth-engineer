import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { streamAgentRun } from "@/lib/agent/uiStream";
import { AppError } from "@/lib/errors";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  decidedBy: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const POST = route<{ approvalId: string }>("approvals.approve", async ({ req, params, log }) => {
  const body = await parseBody(req, Body);
  const runner = getRunner();
  if (req.nextUrl.searchParams.get("stream") === "ui") {
    // Same decision path, streamed in the AI SDK UI message format for the chat UI.
    const approval = await runner.getApproval(params.approvalId);
    if (approval.status !== "pending") throw new AppError("conflict", `Approval already ${approval.status}`, { status: approval.status });
    return streamAgentRun({
      log,
      run: async (events) => (await runner.decideApproval(params.approvalId, "approve", { ...body, events })).run,
    });
  }
  const result = await runner.decideApproval(params.approvalId, "approve", body);
  return NextResponse.json(result, { status: result.approval.status === "expired" ? 410 : 200 });
});
