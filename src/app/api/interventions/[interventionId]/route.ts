import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";

const Body = z.object({ status: z.enum(["completed", "cancelled"]) });

export const GET = route<{ interventionId: string }>("interventions.get", async ({ params }) => {
  return NextResponse.json(await getRunner().getIntervention(params.interventionId));
});

export const PATCH = route<{ interventionId: string }>("interventions.update", async ({ req, params }) => {
  const { status } = await parseBody(req, Body);
  return NextResponse.json(await getRunner().updateInterventionStatus(params.interventionId, status));
});
