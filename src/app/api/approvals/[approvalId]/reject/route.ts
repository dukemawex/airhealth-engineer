import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { streamAgentRun } from "@/lib/agent/uiStream";
import { AppError } from "@/lib/errors";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  reason: z.string().trim().min(1).max(1000).optional(),
  decidedBy: z.string().trim().min(1).max(120).optional(),
});

export const POST = route<{ approvalId: string }>("approvals.reject", async ({ req, params, log }) => {
  const body = await parseBody(req, Body);
  const runner = getRunner();
  if (req.nextUrl.searchParams.get("stream") === "ui") {
    const approval = await runner.getApproval(params.approvalId);
    if (approval.status !== "pending") throw new AppError("conflict", `Approval already ${approval.status}`, { status: approval.status });
    return streamAgentRun({
      log,
      run: async (events) =>
        (await runner.decideApproval(params.approvalId, "reject", { decidedBy: body.decidedBy, note: body.reason, events })).run,
    });
  }
  const result = await runner.decideApproval(params.approvalId, "reject", {
    decidedBy: body.decidedBy,
    note: body.reason,
  });
  return NextResponse.json(result, { status: result.approval.status === "expired" ? 410 : 200 });
});
