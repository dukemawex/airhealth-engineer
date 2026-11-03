"use client";

import { fmtMs, fmtTokens, totalTraces } from "@/lib/traceStats";
import type { StepTrace } from "@/lib/ui-types";

const TOOL_NAMES: Record<string, string> = {
  geocodeLocation: "Find place",
  getAirQuality: "Live air data",
  getHealthContext: "Sensitivity profile",
  designIntervention: "Design room plan",
  planForecast: "72-h forecast plan",
  executeDeviceAction: "Device action",
  getInterventionStatus: "Check status",
};

/**
 * What Muse Spark did this turn, step by step: model time, reasoning tokens and the
 * tools it chose. Collapsed by default; open (with token detail) in Judge mode.
 */
export function ReasoningTimeline({ traces, judge }: { traces: StepTrace[]; judge: boolean }) {
  if (!traces.length) return null;
  const t = totalTraces(traces);
  return (
    <details className="reasoning" open={judge}>
      <summary>
        <span className="reasoning-kicker">How the agent reasoned</span>
        <span className="reasoning-sum">
          {t.steps} step{t.steps === 1 ? "" : "s"} · {fmtMs(t.modelMs + t.toolMs)}
          {t.reasoningTokens > 0 && <> · {fmtTokens(t.reasoningTokens)} reasoning tokens</>}
          {t.approvals > 0 && <> · paused for your approval</>}
        </span>
      </summary>
      <ol className="reasoning-steps">
        {traces.map((s) => (
          <li key={`${s.startedAt}-${s.iteration}`} data-outcome={s.outcome}>
            <span className="reasoning-dot" aria-hidden="true" />
            <div className="reasoning-body">
              <p className="reasoning-line">
                <strong>Step {s.iteration}</strong> · {s.model}
                {s.reasoningEffort && <> · effort {s.reasoningEffort}</>} · thought for {fmtMs(s.modelMs)}
                {s.reasoningTokens != null && <> · {fmtTokens(s.reasoningTokens)} reasoning tokens</>}
              </p>
              {s.tools.length > 0 ? (
                <ul className="reasoning-tools">
                  {s.tools.map((x) => (
                    <li key={x.id} data-status={x.status}>
                      {TOOL_NAMES[x.name] ?? x.name}
                      <span className="reasoning-ms">
                        {x.status === "pending_approval" ? "waiting for your approval" : `${fmtMs(x.ms)}${x.status === "error" ? " · failed" : ""}`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="reasoning-answer">Wrote the reply.</p>
              )}
              {judge && (
                <p className="reasoning-judge">
                  prompt {s.promptTokens ?? "?"} · completion {s.completionTokens ?? "?"} tokens · started{" "}
                  {new Date(s.startedAt).toLocaleTimeString()}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}
