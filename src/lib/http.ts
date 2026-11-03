import { TimeoutError, UpstreamError } from "./errors";
import type { Logger } from "./logger";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** fetch with a hard timeout via AbortController. */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TimeoutError(`Request to ${new URL(String(url)).host} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Upper bound on any single wait, including server-provided Retry-After. */
  maxRetryAfterMs?: number;
  logger?: Logger;
  label: string;
  sleepFn?: (ms: number) => Promise<void>;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof UpstreamError) return err.retryable;
  if (err instanceof TimeoutError) return true;
  // Network-level failures from fetch surface as TypeError in undici.
  return err instanceof TypeError;
}

/** Retry an async operation with exponential backoff + full jitter. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 750;
  const maxDelay = opts.maxDelayMs ?? 8_000;
  const maxRetryAfter = opts.maxRetryAfterMs ?? 20_000;
  const doSleep = opts.sleepFn ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.maxRetries || !isRetryable(err)) throw err;
      const backoff = Math.min(maxDelay, base * 2 ** attempt);
      const jittered = backoff / 2 + Math.random() * (backoff / 2);
      const serverHint = err instanceof UpstreamError ? err.retryAfterMs : undefined;
      const delay = Math.min(maxRetryAfter, Math.max(jittered, serverHint ?? 0));
      opts.logger?.warn("retrying after transient error", {
        label: opts.label,
        attempt: attempt + 1,
        delayMs: Math.round(delay),
        error: err instanceof Error ? err.message : String(err),
      });
      await doSleep(delay);
      attempt += 1;
    }
  }
}

/** Run a promise with a timeout; rejects with TimeoutError. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read a JSON body safely; returns undefined when the body is empty or not JSON. */
export async function readJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2_000);
  }
}
