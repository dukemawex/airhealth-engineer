/** Typed application errors that map cleanly onto HTTP responses. */

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "gone"
  | "config_missing"
  | "upstream_error"
  | "upstream_timeout"
  | "rate_limited"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  gone: 410,
  config_missing: 503,
  upstream_error: 502,
  upstream_timeout: 504,
  rate_limited: 429,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

/** Error raised by an HTTP upstream (Meta Model API, OpenAQ, device APIs). */
export class UpstreamError extends Error {
  readonly service: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly body?: unknown;

  constructor(opts: {
    service: string;
    message: string;
    status?: number;
    retryable: boolean;
    retryAfterMs?: number;
    body?: unknown;
  }) {
    super(opts.message);
    this.name = "UpstreamError";
    this.service = opts.service;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Unknown error";
}
