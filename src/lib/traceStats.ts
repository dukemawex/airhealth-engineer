import type { StepTrace } from "./ui-types";

export interface TraceTotals {
  steps: number;
  modelMs: number;
  toolMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  approvals: number;
}

export function totalTraces(traces: StepTrace[]): TraceTotals {
  return traces.reduce<TraceTotals>(
    (t, s) => ({
      steps: t.steps + 1,
      modelMs: t.modelMs + s.modelMs,
      toolMs: t.toolMs + s.tools.reduce((a, x) => a + x.ms, 0),
      promptTokens: t.promptTokens + (s.promptTokens ?? 0),
      completionTokens: t.completionTokens + (s.completionTokens ?? 0),
      reasoningTokens: t.reasoningTokens + (s.reasoningTokens ?? 0),
      toolCalls: t.toolCalls + s.tools.length,
      approvals: t.approvals + s.tools.filter((x) => x.status === "pending_approval").length,
    }),
    { steps: 0, modelMs: 0, toolMs: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, toolCalls: 0, approvals: 0 },
  );
}

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);
export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
