import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-level smart plug status (env-configured or none), before a conversation exists. */
export const GET = route("plug.status", async () =>
  NextResponse.json(await getRunner().plugInfo(), { headers: { "cache-control": "no-store" } }),
);
