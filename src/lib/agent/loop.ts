import type { AppConfig } from "../config";
import { createDeviceAdapter, type DeviceAdapter } from "../devices";
import type { MonitoringDecision } from "../domain";
import type { Approval, DeviceActionResult, HealthProfile, Intervention, LocationQuery, Session } from "../domain";
import { AppError, UpstreamError, errorMessage } from "../errors";
import { withTimeout, type FetchLike } from "../http";
import { newId } from "../ids";
import type { Logger } from "../logger";
import { hashSafetyIdentifier } from "../meta/client";
import type { ChatMessage, ModelClient, ToolCall } from "../meta/types";
import { fetchAirQuality } from "../services/airQuality";
import { geocodeDepsFromConfig, resolveLocation } from "../services/geocode";
import { decideNotification } from "./monitor";
import { recordAirQuality } from "./sessionState";
import { mergeProfile } from "./tools/getHealthContext";
import { withLock, type StateStore } from "../storage";
import { buildDeveloperPrompt } from "./prompt";
import { buildStatusReport } from "./status";
import { TOOLS, toFunctionDefinitions, toolRegistry, type AgentTool, type ToolContext } from "./tools";

export const MAX_HISTORY_MESSAGES = 80;
export const MAX_TOOL_RESULT_CHARS = 24_000;

export interface AgentDeps {
  config: AppConfig;
  store: StateStore;
  model: ModelClient;
  logger: Logger;
  fetchImpl?: FetchLike;
  /** Adapter instance or lazy factory. Defaults to the one selected by DEVICE_ADAPTER. */
  deviceAdapter?: DeviceAdapter | (() => DeviceAdapter);
  tools?: AgentTool[];
  now?: () => Date;
}

export type RunStatus = "completed" | "awaiting_approval" | "max_iterations" | "budget_exhausted";

export interface ToolCallSummary {
  id: string;
  name: string;
  outcome: "ok" | "error" | "pending_approval";
}

export interface RunResult {
  sessionId: string;
  status: RunStatus;
  reply: string | null;
  iterations: number;
  toolCalls: ToolCallSummary[];
  pendingApprovals: Approval[];
}

/**
 * Optional observer for a run. Used by /api/agent to stream progress to the UI;
 * the JSON REST routes run without it. Callbacks must not throw.
 */
export interface RunEvents {
  onStepStart?(iteration: number): void;
  onTextDelta?(delta: string): void;
  onStepEnd?(iteration: number): void;
  onToolCall?(call: { id: string; name: string; input: unknown }): void;
  onToolResult?(result: { id: string; name: string; ok: boolean; output: unknown }): void;
  onApprovalRequested?(approval: Approval): void;
  onApprovalDecided?(approval: Approval, toolResult: Record<string, unknown>): void;
}

const parseJsonOr = (raw: string) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

export type MonitorResult =
  | { sessionId: string; checked: false; reason: "no_location" | "too_soon" | "busy" | "error"; nextCheckAfter?: string; error?: string }
  | { sessionId: string; checked: true; refreshed: boolean; notified: boolean; decision?: MonitoringDecision; error?: string };

export interface DecisionResult {
  approval: Approval;
  run: RunResult;
}

type ToolOutcome = { kind: "result"; content: string; ok: boolean } | { kind: "approval"; approval: Approval };

const json = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]` : s;
};

/** Keep the tail of the history, always starting at a user message so tool call/result pairs stay intact. */
export function trimHistory(messages: ChatMessage[], max = MAX_HISTORY_MESSAGES): ChatMessage[] {
  if (messages.length <= max) return messages;
  for (let i = messages.length - max; i < messages.length; i++) {
    if (messages[i]?.role === "user") return messages.slice(i);
  }
  return messages;
}

/** Every assistant tool_calls message must be followed by one tool message per call, in order. */
function appendToolMessages(session: Session, toolCalls: ToolCall[], results: Record<string, string>) {
  for (const call of toolCalls) {
    session.messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: results[call.id] ?? json({ error: "No result recorded for this tool call." }),
    });
  }
}

export class AgentRunner {
  private readonly tools: Map<string, AgentTool>;
  private readonly toolDefs;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private adapter?: DeviceAdapter;

  constructor(private readonly deps: AgentDeps) {
    const tools = deps.tools ?? TOOLS;
    this.tools = toolRegistry(tools);
    this.toolDefs = toFunctionDefinitions(tools);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  private get cfg() {
    return this.deps.config;
  }

  getDeviceAdapter = (): DeviceAdapter => {
    if (this.adapter) return this.adapter;
    const d = this.deps.deviceAdapter;
    this.adapter =
      typeof d === "function"
        ? d()
        : d ??
          createDeviceAdapter(this.cfg.devices, {
            store: this.deps.store,
            fetchImpl: this.fetchImpl,
            timeoutMs: this.cfg.agent.toolTimeoutMs,
          });
    return this.adapter;
  };

  private iso() {
    return this.now().toISOString();
  }

  private lockKey(sessionId: string) {
    return `session:${sessionId}`;
  }

  private lockTtl() {
    return this.cfg.agent.runBudgetMs + this.cfg.meta.timeoutMs + 30_000;
  }

  /* ---------------------------------------------------------------- */
  /* Sessions                                                          */
  /* ---------------------------------------------------------------- */

  async createSession(input: { profile?: HealthProfile; location?: LocationQuery; userRef?: string }): Promise<Session> {
    const now = this.iso();
    const session: Session = {
      id: newId("ses"),
      createdAt: now,
      updatedAt: now,
      status: "idle",
      messages: [],
      profile: input.profile,
      userRef: input.userRef,
    };
    if (input.location) {
      session.location = await resolveLocation(
        input.location,
        geocodeDepsFromConfig(this.cfg.airQuality, { fetchImpl: this.fetchImpl, logger: this.deps.logger, timeoutMs: this.cfg.agent.toolTimeoutMs }),
      );
    }
    await this.deps.store.putSession(session);
    if (session.location) await this.deps.store.addMonitoredSession(session.id).catch(() => undefined);
    this.deps.logger.info("session created", { sessionId: session.id, hasLocation: Boolean(session.location) });
    return session;
  }

  async getSession(sessionId: string): Promise<Session> {
    const s = await this.deps.store.getSession(sessionId);
    if (!s) throw new AppError("not_found", `Session ${sessionId} not found`);
    return s;
  }

  async status(sessionId: string) {
    const session = await this.getSession(sessionId);
    let adapter: DeviceAdapter | undefined;
    try {
      adapter = this.getDeviceAdapter();
    } catch {
      adapter = undefined;
    }
    return buildStatusReport(session, this.deps.store, adapter, true);
  }

  private async save(session: Session) {
    session.updatedAt = this.iso();
    await this.deps.store.putSession(session);
  }

  /** Update location and/or health context shared from the UI (not via chat). */
  async updateContext(
    sessionId: string,
    input: { profile?: HealthProfile; location?: LocationQuery; replaceProfile?: boolean },
  ): Promise<Session> {
    await this.getSession(sessionId);
    return withLock(this.deps.store, this.lockKey(sessionId), 30_000, async () => {
      const session = await this.getSession(sessionId);
      if (input.location) {
        session.location = await resolveLocation(
        input.location,
        geocodeDepsFromConfig(this.cfg.airQuality, { fetchImpl: this.fetchImpl, logger: this.deps.logger, timeoutMs: this.cfg.agent.toolTimeoutMs }),
      );
        await this.deps.store.addMonitoredSession(session.id).catch(() => undefined);
      }
      if (input.profile) session.profile = mergeProfile(session.profile, input.profile, input.replaceProfile ?? false);
      await this.save(session);
      return session;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Monitoring                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Re-check air quality for a session and let Muse Spark decide whether the change
   * is worth telling the user. Notifications are appended to the conversation as an
   * assistant message. Never touches devices.
   */
  async monitor(sessionId: string, opts: { force?: boolean } = {}): Promise<MonitorResult> {
    const pre = await this.getSession(sessionId);
    if (!pre.location) return { sessionId, checked: false, reason: "no_location" };
    const last = pre.monitoring?.lastCheckAt ? Date.parse(pre.monitoring.lastCheckAt) : 0;
    if (!opts.force && this.now().getTime() - last < this.cfg.monitoring.minIntervalMs) {
      return { sessionId, checked: false, reason: "too_soon", nextCheckAfter: new Date(last + this.cfg.monitoring.minIntervalMs).toISOString() };
    }
    const token = await this.deps.store.acquireLock(this.lockKey(sessionId), this.lockTtl());
    if (!token) return { sessionId, checked: false, reason: "busy" };
    const log = this.deps.logger.child({ sessionId, op: "monitor" });
    try {
      const session = await this.getSession(sessionId);
      const location = session.location!;
      const previous = session.lastAirQuality;
      session.monitoring = { ...(session.monitoring ?? { enabled: true }), lastCheckAt: this.iso() };
      let snapshot;
      try {
        snapshot = await fetchAirQuality(location, 15_000, {
          fetchImpl: this.fetchImpl,
          logger: log,
          timeoutMs: Math.max(2000, Math.floor(this.cfg.agent.toolTimeoutMs / 3)),
          openaqApiKey: this.cfg.airQuality.openaqApiKey,
          openaqBaseUrl: this.cfg.airQuality.openaqBaseUrl,
          modelFallback: this.cfg.airQuality.modelFallback,
          modelBaseUrl: this.cfg.airQuality.modelBaseUrl,
        });
      } catch (err) {
        session.monitoring.lastError = `Air-quality refresh failed: ${errorMessage(err)}`;
        await this.save(session);
        log.warn("monitor refresh failed", { error: err });
        return { sessionId, checked: true, refreshed: false, notified: false, error: session.monitoring.lastError };
      }
      recordAirQuality(session, snapshot);
      session.monitoring.lastError = undefined;

      let decision: MonitoringDecision = { at: this.iso(), notify: false, severity: "info", message: "" };
      try {
        const interventions = await this.deps.store.listInterventions(sessionId);
        decision = { at: this.iso(), ...(await decideNotification(this.deps.model, session, previous, snapshot, interventions)) };
      } catch (err) {
        session.monitoring.lastError = `Muse Spark could not evaluate the update: ${errorMessage(err)}`;
        log.warn("monitor decision failed", { error: err });
      }
      session.monitoring.lastDecision = decision;
      const canAppend = !session.pendingTurn && session.status !== "running" && session.messages.at(-1)?.role !== "tool";
      const notified = decision.notify && decision.message.trim().length > 0 && canAppend;
      if (notified) {
        session.monitoring.lastNotifiedAt = decision.at;
        session.messages.push({ role: "assistant", content: `**Monitoring update** (${decision.severity}): ${decision.message.trim()}` });
      }
      await this.save(session);
      log.info("monitor check", { notify: decision.notify, notified, source: snapshot.source });
      return { sessionId, checked: true, refreshed: true, notified, decision };
    } finally {
      await this.deps.store.releaseLock(this.lockKey(sessionId), token);
    }
  }

  /** Cron entry point: re-check a bounded batch of monitored sessions sequentially. */
  async monitorAll(): Promise<MonitorResult[]> {
    const ids = await this.deps.store.listMonitoredSessions(this.cfg.monitoring.maxSessionsPerRun);
    const out: MonitorResult[] = [];
    for (const id of ids) {
      try {
        out.push(await this.monitor(id));
      } catch (err) {
        if (err instanceof AppError && err.code === "not_found") {
          await this.deps.store.removeMonitoredSession(id).catch(() => undefined);
        }
        out.push({ sessionId: id, checked: false, reason: "error", error: errorMessage(err) });
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Turns                                                             */
  /* ---------------------------------------------------------------- */

  async sendMessage(sessionId: string, message: string, events?: RunEvents): Promise<RunResult> {
    await this.getSession(sessionId);
    return withLock(this.deps.store, this.lockKey(sessionId), this.lockTtl(), async () => {
      const session = await this.getSession(sessionId);
      if (session.status === "awaiting_approval" || session.pendingTurn) {
        throw new AppError("conflict", "Session is awaiting approval decisions; approve or reject them first.", {
          pendingApprovalIds: session.pendingTurn?.approvalIds ?? [],
        });
      }
      // A previous run may have ended right after tool results (max iterations, error, crash).
      if (session.messages.at(-1)?.role === "tool") {
        session.messages.push({ role: "assistant", content: "(The previous run ended before a final answer.)" });
      }
      session.messages.push({ role: "user", content: message });
      return this.runLoop(session, events);
    });
  }

  /** Continue a run whose last step produced tool results but no final answer (e.g. after a model error). */
  async resume(sessionId: string, events?: RunEvents): Promise<RunResult> {
    await this.getSession(sessionId);
    return withLock(this.deps.store, this.lockKey(sessionId), this.lockTtl(), async () => {
      const session = await this.getSession(sessionId);
      if (session.pendingTurn) throw new AppError("conflict", "Session is awaiting approval decisions.");
      const last = session.messages.at(-1);
      if (!last || (last.role !== "tool" && last.role !== "user")) {
        throw new AppError("conflict", "Nothing to resume: the last run finished with an answer.");
      }
      return this.runLoop(session, events);
    });
  }

  private async runLoop(session: Session, events?: RunEvents): Promise<RunResult> {
    const log = this.deps.logger.child({ sessionId: session.id });
    const started = this.now().getTime();
    const toolCalls: ToolCallSummary[] = [];
    session.status = "running";
    session.lastError = undefined;
    await this.save(session);

    const ctx: ToolContext = {
      session,
      store: this.deps.store,
      config: this.cfg,
      fetchImpl: this.fetchImpl,
      logger: log,
      getDeviceAdapter: this.getDeviceAdapter,
      httpTimeoutMs: Math.max(2000, Math.floor(this.cfg.agent.toolTimeoutMs / 3)),
    };

    const finish = async (status: RunStatus, reply: string | null, iterations: number): Promise<RunResult> => {
      session.status = "idle";
      await this.save(session);
      log.info("run finished", { status, iterations, toolCalls: toolCalls.length });
      return { sessionId: session.id, status, reply, iterations, toolCalls, pendingApprovals: [] };
    };

    try {
      for (let iteration = 1; iteration <= this.cfg.agent.maxIterations; iteration++) {
        if (this.now().getTime() - started > this.cfg.agent.runBudgetMs) {
          log.warn("run budget exhausted", { iteration });
          return await finish("budget_exhausted", null, iteration - 1);
        }

        const request = {
          messages: [
            { role: "developer" as const, content: buildDeveloperPrompt(session, this.now(), this.cfg.devices.adapter) },
            ...trimHistory(session.messages),
          ],
          tools: this.toolDefs,
          safety_identifier: hashSafetyIdentifier(session.userRef ?? session.id),
        };
        events?.onStepStart?.(iteration);
        const response =
          events?.onTextDelta && this.deps.model.streamChatCompletion
            ? await this.deps.model.streamChatCompletion(request, { onTextDelta: (d) => events.onTextDelta?.(d) })
            : await this.deps.model.createChatCompletion(request);
        if (events?.onTextDelta && !this.deps.model.streamChatCompletion && response.choices[0]?.message.content) {
          events.onTextDelta(response.choices[0].message.content);
        }
        const choice = response.choices[0];
        if (!choice) {
          throw new UpstreamError({ service: "meta-model-api", message: "Response had no choices", retryable: false });
        }
        const calls = choice.message.tool_calls ?? [];
        session.messages.push(
          calls.length > 0
            ? { role: "assistant", content: choice.message.content ?? null, tool_calls: calls }
            : { role: "assistant", content: choice.message.content ?? "" },
        );

        if (calls.length === 0) {
          events?.onStepEnd?.(iteration);
          return await finish("completed", choice.message.content ?? "", iteration);
        }

        const results: Record<string, string> = {};
        const approvals: Approval[] = [];
        for (const call of calls) {
          events?.onToolCall?.({ id: call.id, name: call.function.name, input: parseJsonOr(call.function.arguments || "{}") });
          const outcome = await this.handleToolCall(call, ctx);
          if (outcome.kind === "approval") {
            approvals.push(outcome.approval);
            toolCalls.push({ id: call.id, name: call.function.name, outcome: "pending_approval" });
            events?.onApprovalRequested?.(outcome.approval);
          } else {
            results[call.id] = outcome.content;
            toolCalls.push({ id: call.id, name: call.function.name, outcome: outcome.ok ? "ok" : "error" });
            events?.onToolResult?.({ id: call.id, name: call.function.name, ok: outcome.ok, output: parseJsonOr(outcome.content) });
          }
          // Persist tool side effects (location, air-quality snapshot, profile) as they happen.
          await this.save(session);
        }
        events?.onStepEnd?.(iteration);

        if (approvals.length > 0) {
          session.pendingTurn = { toolCalls: calls, results, approvalIds: approvals.map((a) => a.id) };
          session.status = "awaiting_approval";
          await this.save(session);
          log.info("run paused for approval", { approvalIds: session.pendingTurn.approvalIds, iteration });
          return {
            sessionId: session.id,
            status: "awaiting_approval",
            reply: choice.message.content ?? null,
            iterations: iteration,
            toolCalls,
            pendingApprovals: approvals,
          };
        }

        appendToolMessages(session, calls, results);
        await this.save(session);
      }
      log.warn("max iterations reached", { maxIterations: this.cfg.agent.maxIterations });
      return await finish("max_iterations", null, this.cfg.agent.maxIterations);
    } catch (err) {
      session.status = "error";
      session.lastError = errorMessage(err);
      await this.save(session).catch(() => undefined);
      log.error("run failed", { error: err });
      throw err;
    }
  }

  private async handleToolCall(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const log = ctx.logger.child({ toolCallId: call.id, tool: call.function.name });
    const fail = (error: string, extra: Record<string, unknown> = {}): ToolOutcome => {
      log.warn("tool call rejected", { error });
      return { kind: "result", ok: false, content: json({ error, ...extra }) };
    };

    const tool = this.tools.get(call.function.name);
    if (!tool) return fail(`Unknown tool '${call.function.name}'. Available: ${[...this.tools.keys()].join(", ")}`);

    let rawArgs: unknown;
    try {
      rawArgs = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {};
    } catch {
      return fail("Tool arguments were not valid JSON. Re-issue the call with a JSON object.");
    }
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return fail("Invalid arguments", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    if (tool.requiresApproval) {
      const refusal = tool.validateForApproval ? await tool.validateForApproval(parsed.data, ctx) : null;
      if (refusal) return fail(refusal);
      const args = parsed.data as { command: Approval["command"]; reason: string; interventionId?: string };
      const createdAt = this.now();
      const approval: Approval = {
        id: newId("apr"),
        sessionId: ctx.session.id,
        toolCallId: call.id,
        toolName: tool.name,
        status: "pending",
        command: args.command,
        reason: args.reason,
        interventionId: args.interventionId,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + this.cfg.agent.approvalTtlMs).toISOString(),
      };
      await this.deps.store.putApproval(approval);
      log.info("approval requested", { approvalId: approval.id, command: approval.command });
      return { kind: "approval", approval };
    }

    if (!tool.execute) return fail(`Tool '${tool.name}' is not executable.`);
    const t0 = Date.now();
    try {
      const result = await withTimeout(tool.execute(parsed.data, ctx), this.cfg.agent.toolTimeoutMs, `tool ${tool.name}`);
      log.info("tool executed", { latencyMs: Date.now() - t0 });
      return { kind: "result", ok: true, content: json(result) };
    } catch (err) {
      log.warn("tool failed", { latencyMs: Date.now() - t0, error: err });
      return {
        kind: "result",
        ok: false,
        content: json({
          error: errorMessage(err),
          code: err instanceof AppError ? err.code : undefined,
          hint: "Explain the failure to the user or try different arguments; do not fabricate data.",
        }),
      };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Approval gate                                                     */
  /* ---------------------------------------------------------------- */

  async getApproval(approvalId: string): Promise<Approval> {
    const a = await this.deps.store.getApproval(approvalId);
    if (!a) throw new AppError("not_found", `Approval ${approvalId} not found`);
    if (a.status === "pending" && this.now().getTime() > Date.parse(a.expiresAt)) {
      return { ...a, status: "expired" };
    }
    return a;
  }

  async listApprovals(sessionId: string, status?: Approval["status"]): Promise<Approval[]> {
    await this.getSession(sessionId);
    const all = await this.deps.store.listApprovals(sessionId);
    const nowMs = this.now().getTime();
    return all
      .map((a) => (a.status === "pending" && nowMs > Date.parse(a.expiresAt) ? { ...a, status: "expired" as const } : a))
      .filter((a) => !status || a.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Record a human decision. Approve executes the device command via the adapter
   * (exactly once, under the session lock); reject/expiry never executes. When the
   * last pending approval of the paused turn is decided, the loop resumes.
   */
  async decideApproval(
    approvalId: string,
    decision: "approve" | "reject",
    opts: { decidedBy?: string; note?: string; events?: RunEvents } = {},
  ): Promise<DecisionResult> {
    const initial = await this.deps.store.getApproval(approvalId);
    if (!initial) throw new AppError("not_found", `Approval ${approvalId} not found`);
    const sessionId = initial.sessionId;

    return withLock(this.deps.store, this.lockKey(sessionId), this.lockTtl(), async () => {
      const approval = (await this.deps.store.getApproval(approvalId))!;
      const session = await this.getSession(sessionId);
      const log = this.deps.logger.child({ sessionId, approvalId });

      if (approval.status !== "pending") {
        throw new AppError("conflict", `Approval already ${approval.status}`, { status: approval.status });
      }
      const turn = session.pendingTurn;
      if (!turn || !turn.approvalIds.includes(approval.id)) {
        throw new AppError("conflict", "Approval is not part of the session's paused turn.");
      }

      const decidedAt = this.iso();
      approval.decidedAt = decidedAt;
      approval.decidedBy = opts.decidedBy;
      approval.decisionNote = opts.note;
      let toolResult: Record<string, unknown>;

      if (this.now().getTime() > Date.parse(approval.expiresAt)) {
        approval.status = "expired";
        toolResult = {
          status: "expired",
          executed: false,
          message: "The approval window expired before a decision; nothing was executed. Do not resend unless the user asks.",
        };
        log.info("approval expired");
      } else if (decision === "reject") {
        approval.status = "rejected";
        toolResult = {
          status: "rejected",
          executed: false,
          reason: opts.note ?? "No reason given",
          message: "A human rejected this device action; nothing was executed. Do not resend it unless the user asks.",
        };
        log.info("approval rejected");
      } else {
        approval.status = "approved";
        await this.deps.store.putApproval(approval);
        let result: DeviceActionResult;
        try {
          result = await withTimeout(
            this.getDeviceAdapter().execute(approval.command, { sessionId, approvalId, approvedBy: opts.decidedBy }),
            this.cfg.agent.toolTimeoutMs,
            "device action",
          );
          approval.status = "executed";
          log.info("device action executed", { adapter: result.adapter });
        } catch (err) {
          result = { ok: false, adapter: this.cfg.devices.adapter, executedAt: this.iso(), message: errorMessage(err) };
          approval.status = "failed";
          log.error("device action failed", { error: err });
        }
        approval.result = result;
        toolResult = {
          status: approval.status,
          executed: approval.status === "executed",
          approvedBy: opts.decidedBy,
          result,
        };
        if (approval.status === "executed" && approval.interventionId) {
          await this.activateIntervention(approval.interventionId, sessionId);
        }
      }
      await this.deps.store.putApproval(approval);
      turn.results[approval.toolCallId] = json(toolResult);
      opts.events?.onApprovalDecided?.(approval, toolResult);

      const remainingIds = turn.approvalIds.filter((id) => id !== approval.id);
      const stillPending: Approval[] = [];
      for (const id of remainingIds) {
        const a = await this.deps.store.getApproval(id);
        if (a && turn.results[a.toolCallId] === undefined) stillPending.push(a);
      }

      if (stillPending.length > 0) {
        await this.save(session);
        return {
          approval,
          run: {
            sessionId,
            status: "awaiting_approval",
            reply: null,
            iterations: 0,
            toolCalls: [],
            pendingApprovals: stillPending,
          },
        };
      }

      appendToolMessages(session, turn.toolCalls, turn.results);
      session.pendingTurn = undefined;
      const run = await this.runLoop(session, opts.events);
      return { approval, run };
    });
  }

  private async activateIntervention(interventionId: string, sessionId: string) {
    const i = await this.deps.store.getIntervention(interventionId);
    if (i && i.sessionId === sessionId && i.status === "proposed") {
      await this.deps.store.putIntervention({ ...i, status: "active", updatedAt: this.iso() });
    }
  }

  async updateInterventionStatus(interventionId: string, status: "completed" | "cancelled"): Promise<Intervention> {
    const i = await this.deps.store.getIntervention(interventionId);
    if (!i) throw new AppError("not_found", `Intervention ${interventionId} not found`);
    if (i.status === "completed" || i.status === "cancelled") {
      throw new AppError("conflict", `Intervention already ${i.status}`);
    }
    const updated: Intervention = { ...i, status, updatedAt: this.iso() };
    await this.deps.store.putIntervention(updated);
    return updated;
  }

  async getIntervention(interventionId: string): Promise<Intervention> {
    const i = await this.deps.store.getIntervention(interventionId);
    if (!i) throw new AppError("not_found", `Intervention ${interventionId} not found`);
    return i;
  }
}
