import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { getRunner } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Vercel Cron target (see vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET`
 * when CRON_SECRET is set: https://vercel.com/docs/cron-jobs/manage-cron-jobs
 * Refuses to run when CRON_SECRET is not configured.
 */
export const GET = route(
  "cron.monitor",
  async ({ req }) => {
    const secret = getConfig().monitoring.cronSecret;
    if (!secret) throw new AppError("config_missing", "CRON_SECRET is not set; the monitor cron is disabled.");
    const presented = Buffer.from(req.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new AppError("unauthorized", "Invalid cron secret");
    }
    const results = await getRunner().monitorAll();
    return NextResponse.json({
      checked: results.filter((r) => r.checked).length,
      notified: results.filter((r) => r.checked && r.notified).length,
      results,
    });
  },
  { auth: false },
);
