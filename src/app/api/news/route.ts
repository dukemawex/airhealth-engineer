import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getNewsDigest } from "@/lib/services/news";

export const runtime = "nodejs";

/** GET /api/news?place=Lagos — cached RSS digest (see src/lib/services/news.ts). */
export const GET = route("news", async ({ req, log }) => {
  const place = req.nextUrl.searchParams.get("place")?.trim().slice(0, 80) || undefined;
  const digest = await getNewsDigest(place, { fetchImpl: fetch, logger: log });
  return NextResponse.json(digest, { headers: { "cache-control": "private, max-age=600" } });
});
