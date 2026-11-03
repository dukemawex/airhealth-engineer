import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config";
import { AppError, TimeoutError, UpstreamError } from "../errors";
import { fetchWithTimeout, parseRetryAfter, readJsonSafe, withRetry, type FetchLike } from "../http";
import type { Logger } from "../logger";
import type { ChatCompletionRequest, ChatCompletionResponse, ModelClient, StreamCallbacks } from "./types";

/**
 * Meta Model API client for Muse Spark via the OpenAI-compatible Chat Completions
 * endpoint.
 *
 *   POST {META_API_BASE_URL}/chat/completions   (default base: https://api.meta.ai/v1)
 *   Authorization: Bearer $MODEL_API_KEY
 *
 * Docs:
 *   https://dev.meta.ai/docs/api-reference
 *   https://dev.meta.ai/docs/protocols/chat-completions
 *   https://dev.meta.ai/docs/tool-calling
 *   https://dev.meta.ai/docs/error-handling
 *
 * Retry policy follows the error-handling guide: retry 429/500/503 (and network
 * failures / client-side timeouts) with exponential backoff + jitter, honouring
 * Retry-After; never retry 400/401/402/403/404/413; do not blindly retry 504
 * (gateway_timeout) because the same request usually times out again.
 */

const ResponseSchema = z.object({
  id: z.string().default(""),
  object: z.string().default("chat.completion"),
  created: z.number().default(0),
  model: z.string().default(""),
  choices: z
    .array(
      z.object({
        index: z.number().default(0),
        message: z.object({
          role: z.literal("assistant").default("assistant"),
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal("function").default("function"),
                function: z.object({ name: z.string(), arguments: z.string().default("{}") }),
              }),
            )
            .optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).nullable().optional(),
    })
    .partial()
    .optional(),
});

const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);

export function hashSafetyIdentifier(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 64);
}

export class MetaModelClient implements ModelClient {
  readonly modelId: string;
  private readonly cfg: AppConfig["meta"];
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly sleepFn?: (ms: number) => Promise<void>;

  constructor(opts: {
    config: AppConfig["meta"];
    logger: Logger;
    fetchImpl?: FetchLike;
    sleepFn?: (ms: number) => Promise<void>;
  }) {
    this.cfg = opts.config;
    this.modelId = opts.config.modelId;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.logger = opts.logger.child({ component: "meta-model-api", model: this.modelId });
    this.sleepFn = opts.sleepFn;
  }

  async createChatCompletion(req: Omit<ChatCompletionRequest, "model" | "stream">): Promise<ChatCompletionResponse> {
    const apiKey = this.cfg.apiKey;
    if (!apiKey) {
      throw new AppError("config_missing", "MODEL_API_KEY is not set; the Muse Spark agent cannot run.");
    }
    const body: ChatCompletionRequest = {
      model: this.cfg.modelId,
      ...req,
      ...(req.tools && req.tools.length > 0
        ? { tool_choice: "auto" as const, parallel_tool_calls: this.cfg.parallelToolCalls }
        : {}),
      ...(!req.reasoning_effort && this.cfg.reasoningEffort ? { reasoning_effort: this.cfg.reasoningEffort } : {}),
    };
    const url = `${this.cfg.baseUrl}/chat/completions`;

    return withRetry(
      async (attempt) => {
        const started = Date.now();
        const res = await fetchWithTimeout(
          this.fetchImpl,
          url,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
          this.cfg.timeoutMs,
        );
        const payload = await readJsonSafe(res);
        const latencyMs = Date.now() - started;

        if (!res.ok) {
          const err = (payload as { error?: { message?: string; type?: string; code?: string | null } })?.error;
          this.logger.warn("meta model api error", {
            status: res.status,
            errorType: err?.type,
            errorCode: err?.code,
            attempt,
            latencyMs,
          });
          throw new UpstreamError({
            service: "meta-model-api",
            status: res.status,
            message: `Meta Model API ${res.status}: ${err?.message ?? (res.status === 404 ? "endpoint or model not found" : "request failed")}`,
            retryable: RETRYABLE_STATUS.has(res.status),
            retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
            body: err ?? undefined,
          });
        }

        const parsed = ResponseSchema.safeParse(payload);
        if (!parsed.success) {
          throw new UpstreamError({
            service: "meta-model-api",
            status: res.status,
            message: "Meta Model API returned an unexpected response shape",
            retryable: false,
            body: parsed.error.issues.slice(0, 5),
          });
        }
        this.logger.info("meta model api completion", {
          attempt,
          latencyMs,
          finishReason: parsed.data.choices[0]?.finish_reason,
          toolCalls: parsed.data.choices[0]?.message.tool_calls?.length ?? 0,
          usage: parsed.data.usage,
        });
        return parsed.data as ChatCompletionResponse;
      },
      {
        maxRetries: this.cfg.maxRetries,
        label: "meta.chat.completions",
        logger: this.logger,
        sleepFn: this.sleepFn,
      },
    );
  }
  /**
   * Streaming completion. Retries (per the error-handling guide) only happen before
   * any bytes are received; once text has been emitted, a mid-stream failure is
   * surfaced to the caller rather than replayed. An idle timeout of META_TIMEOUT_MS
   * applies between chunks.
   */
  async streamChatCompletion(
    req: Omit<ChatCompletionRequest, "model" | "stream">,
    callbacks: StreamCallbacks,
  ): Promise<ChatCompletionResponse> {
    const apiKey = this.cfg.apiKey;
    if (!apiKey) {
      throw new AppError("config_missing", "MODEL_API_KEY is not set; the Muse Spark agent cannot run.");
    }
    const body: ChatCompletionRequest = {
      model: this.cfg.modelId,
      ...req,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.tools && req.tools.length > 0
        ? { tool_choice: "auto" as const, parallel_tool_calls: this.cfg.parallelToolCalls }
        : {}),
      ...(!req.reasoning_effort && this.cfg.reasoningEffort ? { reasoning_effort: this.cfg.reasoningEffort } : {}),
    };
    const url = `${this.cfg.baseUrl}/chat/completions`;

    const res = await withRetry(
      async (attempt) => {
        const r = await fetchWithTimeout(
          this.fetchImpl,
          url,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(body),
          },
          this.cfg.timeoutMs,
        );
        if (!r.ok || !r.body) {
          const payload = await readJsonSafe(r);
          const err = (payload as { error?: { message?: string; type?: string; code?: string | null } })?.error;
          this.logger.warn("meta model api stream error", { status: r.status, errorType: err?.type, attempt });
          throw new UpstreamError({
            service: "meta-model-api",
            status: r.status,
            message: `Meta Model API ${r.status}: ${err?.message ?? "stream request failed"}`,
            retryable: RETRYABLE_STATUS.has(r.status),
            retryAfterMs: parseRetryAfter(r.headers.get("retry-after")),
            body: err ?? undefined,
          });
        }
        return r;
      },
      { maxRetries: this.cfg.maxRetries, label: "meta.chat.completions.stream", logger: this.logger, sleepFn: this.sleepFn },
    );

    const started = Date.now();
    const acc = new StreamAccumulator();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const bodyStream = res.body!;
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        void bodyStream.cancel().catch(() => undefined);
      }, this.cfg.timeoutMs);
    };
    arm();
    try {
      for await (const chunk of readSse(bodyStream, arm)) acc.push(chunk, callbacks.onTextDelta);
    } catch (err) {
      if (timedOut) throw new TimeoutError(`Meta Model API stream idle for ${this.cfg.timeoutMs}ms`);
      throw err;
    } finally {
      if (idle) clearTimeout(idle);
    }
    if (timedOut) throw new TimeoutError(`Meta Model API stream idle for ${this.cfg.timeoutMs}ms`);
    const result = acc.result();
    this.logger.info("meta model api stream completed", {
      latencyMs: Date.now() - started,
      finishReason: result.choices[0]?.finish_reason,
      toolCalls: result.choices[0]?.message.tool_calls?.length ?? 0,
      usage: result.usage,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* Streaming (stream: true → text/event-stream)                        */
/* ------------------------------------------------------------------ */

const StreamChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  created: z.number().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().default(0),
        delta: z
          .object({
            role: z.string().optional(),
            content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number(),
                  id: z.string().optional(),
                  type: z.string().optional(),
                  function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).partial().optional(),
                }),
              )
              .optional(),
          })
          .partial()
          .default({}),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).nullable().optional(),
    })
    .partial()
    .nullable()
    .optional(),
});

/**
 * Aggregates Chat Completions SSE chunks. Per https://dev.meta.ai/docs/tool-calling,
 * tool_calls deltas are accumulated across chunks by `index`.
 */
export class StreamAccumulator {
  id = "";
  model = "";
  created = 0;
  content = "";
  finishReason: string | null = null;
  usage?: ChatCompletionResponse["usage"];
  private calls = new Map<number, { id: string; name: string; args: string }>();

  push(raw: unknown, onTextDelta?: (d: string) => void) {
    const parsed = StreamChunkSchema.safeParse(raw);
    if (!parsed.success) return;
    const chunk = parsed.data;
    if (chunk.id) this.id = chunk.id;
    if (chunk.model) this.model = chunk.model;
    if (chunk.created) this.created = chunk.created;
    if (chunk.usage) this.usage = chunk.usage as ChatCompletionResponse["usage"];
    for (const choice of chunk.choices) {
      if (choice.index !== 0) continue;
      const delta = choice.delta;
      if (delta.content) {
        this.content += delta.content;
        onTextDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = this.calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        this.calls.set(tc.index, cur);
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
  }

  result(): ChatCompletionResponse {
    const toolCalls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        id: c.id || `call_${this.id || "stream"}_${index}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
      }));
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: this.content.length > 0 ? this.content : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: this.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
        },
      ],
      usage: this.usage,
    };
  }
}

/** Parse an SSE body into JSON `data:` payloads, stopping at `[DONE]`. */
export async function* readSse(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
