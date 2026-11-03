import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter } from "ai";
import { ConfigError } from "../config";
import type { Approval, Session } from "../domain";
import { AppError, TimeoutError, UpstreamError, errorMessage } from "../errors";
import type { Logger } from "../logger";
import { toApprovalView, type AgentUIMessage, type NoticeData, type StepTrace } from "../ui-types";
import type { RunEvents, RunResult } from "./loop";

/**
 * Bridges AgentRunner events to the Vercel AI SDK UI message stream protocol
 * (SSE, header x-vercel-ai-ui-message-stream: v1) so `useChat` can render
 * Muse Spark text deltas, tool cards and approval requests. No AI SDK model
 * provider is involved: Muse Spark (via MetaModelClient) remains the only LLM.
 */

type Writer = UIMessageStreamWriter<AgentUIMessage>;

/** Translate failures into a clear, user-facing notice. Never leaks secrets or stack traces. */
export function toNotice(err: unknown): NoticeData {
  if (err instanceof AppError) {
    if (err.code === "config_missing") {
      return { level: "error", code: err.code, message: `Configuration needed: ${err.message}`, retryable: false };
    }
    return { level: "error", code: err.code, message: err.message, retryable: err.code === "conflict" };
  }
  if (err instanceof ConfigError) {
    return { level: "error", code: "config_invalid", message: "The server configuration is invalid. Check /api/health.", retryable: false };
  }
  if (err instanceof UpstreamError) {
    if (err.service === "meta-model-api") {
      if (err.status === 429) {
        return { level: "warning", code: "meta_rate_limited", message: "Muse Spark is rate-limiting requests right now. Your conversation is saved; try again in a minute.", retryable: true };
      }
      if (err.status === 401 || err.status === 403) {
        return { level: "error", code: "meta_auth", message: "The Meta Model API rejected the API key. Check MODEL_API_KEY.", retryable: false };
      }
      if (err.status === 504) {
        return { level: "warning", code: "meta_timeout", message: "Muse Spark took too long to respond (gateway timeout). Try again, ideally with a shorter request.", retryable: true };
      }
      return { level: "warning", code: "meta_unavailable", message: `Muse Spark is temporarily unavailable (${err.status ?? "network error"}). Tool results so far were kept; retry to continue.`, retryable: true };
    }
    return { level: "warning", code: "upstream_error", message: `${err.service} is unavailable right now.`, retryable: true };
  }
  if (err instanceof TimeoutError) {
    return { level: "warning", code: "timeout", message: `${err.message}. Partial results were kept; retry to continue.`, retryable: true };
  }
  return { level: "error", code: "internal_error", message: "Something went wrong on the server. Your conversation is saved; try again.", retryable: true };
}

class StreamBridge implements RunEvents {
  private textId: string | null = null;
  private n = 0;
  constructor(private readonly w: Writer) {}

  private closeText() {
    if (this.textId) {
      this.w.write({ type: "text-end", id: this.textId });
      this.textId = null;
    }
  }
  text(s: string) {
    if (!this.textId) {
      this.textId = `txt_${Date.now().toString(36)}_${this.n++}`;
      this.w.write({ type: "text-start", id: this.textId });
    }
    this.w.write({ type: "text-delta", id: this.textId, delta: s });
  }
  onStepStart() {
    this.w.write({ type: "start-step" });
  }
  onTextDelta(delta: string) {
    this.text(delta);
  }
  onStepEnd() {
    this.closeText();
    this.w.write({ type: "finish-step" });
  }
  onToolCall(call: { id: string; name: string; input: unknown }) {
    this.closeText();
    this.w.write({ type: "tool-input-available", toolCallId: call.id, toolName: call.name, input: call.input, dynamic: true });
  }
  onToolResult(r: { id: string; name: string; ok: boolean; output: unknown }) {
    this.w.write({ type: "tool-output-available", toolCallId: r.id, output: r.output, dynamic: true });
  }
  onToolProgress(p: { id: string; name: string; message: string }) {
    this.w.write({ type: "data-progress", id: `progress_${p.id}`, data: { toolCallId: p.id, tool: p.name, message: p.message } });
  }
    onApprovalRequested(a: Approval) {
    this.w.write({ type: "data-approval", id: a.id, data: toApprovalView(a) });
  }
  onApprovalDecided(a: Approval, toolResult: Record<string, unknown>) {
    this.w.write({ type: "data-approval", id: a.id, data: toApprovalView(a) });
    this.w.write({ type: "tool-output-available", toolCallId: a.toolCallId, output: toolResult, dynamic: true });
  }
  onTrace(t: StepTrace) {
    this.w.write({ type: "data-trace", id: `trace_${t.startedAt}_${t.iteration}`, data: t });
  }
  finish() {
    this.closeText();
  }
}

/**
 * Run an agent operation and stream it. Errors become a friendly assistant text +
 * a `data-notice` part instead of a broken stream, so the UI never crashes.
 */
export function streamAgentRun(opts: {
  log: Logger;
  conversationId?: string;
  run: (events: RunEvents) => Promise<RunResult>;
  headers?: Record<string, string>;
}): Response {
  const stream = createUIMessageStream<AgentUIMessage>({
    execute: async ({ writer }) => {
      const bridge = new StreamBridge(writer);
      writer.write({ type: "start" });
      if (opts.conversationId) {
        writer.write({ type: "data-conversation", id: "conversation", data: { id: opts.conversationId } });
      }
      try {
        const result = await opts.run(bridge);
        bridge.finish();
        writer.write({ type: "data-run", id: "run", data: { status: result.status, iterations: result.iterations } });
        if (result.status === "max_iterations" || result.status === "budget_exhausted") {
          writer.write({
            type: "data-notice",
            id: "notice",
            data: {
              level: "warning",
              code: result.status,
              message:
                result.status === "max_iterations"
                  ? "The agent hit its step limit before finishing. Results so far are saved; send “continue” to resume."
                  : "The agent ran out of its time budget for this turn. Results so far are saved; send “continue” to resume.",
              retryable: true,
            },
          });
        }
      } catch (err) {
        bridge.finish();
        const notice = toNotice(err);
        opts.log.warn("agent stream failed", { code: notice.code, error: errorMessage(err) });
        writer.write({ type: "data-notice", id: "notice", data: notice });
        writer.write({ type: "data-run", id: "run", data: { status: "failed", iterations: 0 } });
      }
      writer.write({ type: "finish" });
    },
    onError: (err) => toNotice(err).message,
  });
  return createUIMessageStreamResponse({ stream, headers: opts.headers });
}

const parse = (raw: string | null | undefined): unknown => {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * Rebuild useChat messages from the persisted conversation (server is the source of
 * truth). One assistant UI message per run, tool calls as dynamic-tool parts.
 */
export function sessionToUIMessages(session: Session, approvals: Approval[]): AgentUIMessage[] {
  const out: AgentUIMessage[] = [];
  const approvalByCall = new Map(approvals.map((a) => [a.toolCallId, a]));
  let current: AgentUIMessage | null = null;
  type Part = AgentUIMessage["parts"][number];
  const findTool = (id: string) =>
    current?.parts.find((p): p is Extract<Part, { type: "dynamic-tool" }> => p.type === "dynamic-tool" && p.toolCallId === id);

  session.messages.forEach((m, i) => {
    if (m.role === "user") {
      current = null;
      out.push({ id: `${session.id}_m${i}`, role: "user", parts: [{ type: "text", text: userText(m.content) }] });
      return;
    }
    if (m.role === "assistant") {
      const isMonitor = typeof m.content === "string" && m.content.startsWith("**Monitoring update**");
      if (!current || isMonitor) {
        current = { id: `${session.id}_m${i}`, role: "assistant", parts: [] };
        out.push(current);
      }
      if (m.content) current.parts.push({ type: "text", text: m.content, state: "done" });
      for (const tc of ("tool_calls" in m ? m.tool_calls : undefined) ?? []) {
        current.parts.push({
          type: "dynamic-tool",
          toolName: tc.function.name,
          toolCallId: tc.id,
          state: "input-available",
          input: parse(tc.function.arguments),
        });
        const a = approvalByCall.get(tc.id);
        if (a) current.parts.push({ type: "data-approval", id: a.id, data: toApprovalView(a) });
      }
      return;
    }
    if (m.role === "tool") {
      const part = findTool(m.tool_call_id);
      if (part) Object.assign(part, { state: "output-available", output: parse(m.content) });
    }
  });
  // Results already produced inside a turn that is paused for approval.
  for (const [callId, raw] of Object.entries(session.pendingTurn?.results ?? {})) {
    const part = findTool(callId);
    if (part) Object.assign(part, { state: "output-available", output: parse(raw) });
  }
  return out;
}

function userText(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === "string" ? content : content.map((p) => (p.type === "text" ? p.text ?? "" : "")).join("\n");
}
