/**
 * Types shared by the server UI stream (/api/agent) and the React client.
 * Must stay free of Node-only imports.
 */
import type { UIMessage } from "ai";
import type { Approval } from "./domain";
import type { VisionResult } from "./vision/scene";

export type ApprovalView = Pick<
  Approval,
  "id" | "toolCallId" | "status" | "command" | "reason" | "interventionId" | "createdAt" | "expiresAt" | "decidedAt" | "decidedBy" | "decisionNote" | "result"
>;

export interface NoticeData {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  retryable: boolean;
}

export interface RunData {
  status: "completed" | "awaiting_approval" | "max_iterations" | "budget_exhausted" | "failed";
  iterations: number;
}

export type AgentDataParts = {
  approval: ApprovalView;
  conversation: { id: string };
  notice: NoticeData;
  run: RunData;
};

/** Client-side metadata on user turns (a photo shared with that message). Never persisted server-side. */
export interface AgentMessageMeta {
  scene?: { imageUrl?: string; result: VisionResult; kind?: "photo" | "video_frame" };
}

export type AgentUIMessage = UIMessage<AgentMessageMeta, AgentDataParts>;

export const toApprovalView = (a: Approval): ApprovalView => ({
  id: a.id,
  toolCallId: a.toolCallId,
  status: a.status,
  command: a.command,
  reason: a.reason,
  interventionId: a.interventionId,
  createdAt: a.createdAt,
  expiresAt: a.expiresAt,
  decidedAt: a.decidedAt,
  decidedBy: a.decidedBy,
  decisionNote: a.decisionNote,
  result: a.result,
});
