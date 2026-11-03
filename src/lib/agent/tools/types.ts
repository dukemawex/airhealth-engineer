import type { z } from "zod";
import type { AppConfig } from "../../config";
import type { Session } from "../../domain";
import type { FetchLike } from "../../http";
import type { Logger } from "../../logger";
import type { StateStore } from "../../storage";
import type { DeviceAdapter } from "../../devices";
import type { ModelClient } from "../../meta/types";

export interface ToolContext {
  /** Mutable working copy of the session; the loop persists it after each step. */
  session: Session;
  store: StateStore;
  config: AppConfig;
  fetchImpl: FetchLike;
  logger: Logger;
  getDeviceAdapter: () => DeviceAdapter;
  /** Per-HTTP-request timeout for upstream calls made inside a tool (tool timeout / 3). */
  httpTimeoutMs: number;
  /** Muse Spark client for tools that plan with the model (optional in tests). */
  model?: ModelClient;
  /** Stream a short progress line to the UI while this tool runs. */
  progress?: (message: string) => void;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /**
   * When true the loop NEVER executes the tool inline. It persists a pending
   * approval and pauses; execution happens only via the approval endpoint.
   */
  requiresApproval: boolean;
  /** Override the default per-tool timeout (e.g. model-backed planners). */
  timeoutMs?: number;
  /** Inline execution for non-gated tools. */
  execute?: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
  /** Optional pre-approval validation for gated tools; return an error string to refuse. */
  validateForApproval?: (args: z.infer<S>, ctx: ToolContext) => Promise<string | null>;
}

export const defineTool = <S extends z.ZodType>(tool: AgentTool<S>): AgentTool<S> => tool;
