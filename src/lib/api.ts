import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { ConfigError, getConfig } from "./config";
import { AppError, TimeoutError, UpstreamError } from "./errors";
import { newId } from "./ids";
import { logger, type Logger } from "./logger";

export function errorResponse(err: unknown, requestId: string, log: Logger): NextResponse {
  let status = 500;
  let body: { error: { code: string; message: string; details?: unknown; requestId: string } };
  if (err instanceof AppError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message, details: err.details, requestId } };
  } else if (err instanceof ConfigError) {
    status = 503;
    body = { error: { code: "config_invalid", message: err.message, requestId } };
  } else if (err instanceof UpstreamError) {
    status = err.status === 429 ? 429 : 502;
    body = { error: { code: "upstream_error", message: `${err.service}: ${err.message}`, requestId } };
  } else if (err instanceof TimeoutError) {
    status = 504;
    body = { error: { code: "upstream_timeout", message: err.message, requestId } };
  } else {
    body = { error: { code: "internal_error", message: "Internal server error", requestId } };
  }
  (status >= 500 ? log.error : log.warn)("request failed", { status, error: err });
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId } });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Optional bearer auth: enforced only when API_AUTH_TOKEN is configured. */
export function requireAuth(req: NextRequest) {
  const token = getConfig().apiAuthToken;
  if (!token) return;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !safeEqual(presented, token)) {
    throw new AppError("unauthorized", "Missing or invalid bearer token");
  }
}

export async function parseBody<S extends z.ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  let raw: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AppError("bad_request", "Body must be valid JSON");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("bad_request", "Invalid request body", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

type Handler<P> = (ctx: { req: NextRequest; params: P; requestId: string; log: Logger }) => Promise<Response>;

/** Wraps a route handler with request ids, structured logging, auth and error mapping. */
export function route<P = Record<string, never>>(
  name: string,
  handler: Handler<P>,
  opts: { auth?: boolean } = {},
) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) => {
    const requestId = req.headers.get("x-request-id") ?? newId("req");
    const log = logger.child({ requestId, route: name });
    const t0 = Date.now();
    try {
      if (opts.auth !== false) requireAuth(req);
      const params = ((await ctx?.params) ?? {}) as P;
      const res = await handler({ req, params, requestId, log });
      res.headers.set("x-request-id", requestId);
      log.info("request completed", { method: req.method, status: res.status, latencyMs: Date.now() - t0 });
      return res;
    } catch (err) {
      return errorResponse(err, requestId, log);
    }
  };
}
