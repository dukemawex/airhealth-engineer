import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";

export const GET = route<{ approvalId: string }>("approvals.get", async ({ params }) => {
  return NextResponse.json(await getRunner().getApproval(params.approvalId));
});
