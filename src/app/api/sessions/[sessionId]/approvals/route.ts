import { NextResponse } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";

const Status = z.enum(["pending", "approved", "rejected", "expired", "executed", "failed"]);

export const GET = route<{ sessionId: string }>("sessions.approvals", async ({ req, params }) => {
  const raw = req.nextUrl.searchParams.get("status");
  const parsed = raw ? Status.safeParse(raw) : undefined;
  if (parsed && !parsed.success) throw new AppError("bad_request", `status must be one of ${Status.options.join(", ")}`);
  const approvals = await getRunner().listApprovals(params.sessionId, parsed?.data);
  return NextResponse.json({ approvals });
});
