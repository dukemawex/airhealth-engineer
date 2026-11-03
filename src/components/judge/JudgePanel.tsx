"use client";

import { useEffect, useState } from "react";
import { fmtMs, fmtTokens, type TraceTotals } from "@/lib/traceStats";

interface Caps {
  checkedAt: string;
  reachable: boolean;
  features: Record<"agent" | "vision" | "segmentation" | "transcribe" | "image", boolean>;
  modelIds: Record<string, string>;
  error?: string;
}

const ROWS: Array<{ key: keyof Caps["features"]; what: string; endpoint: string; fallback: string }> = [
  { key: "agent", what: "Agent loop: tool calling, streaming, reasoning", endpoint: "POST /v1/chat/completions", fallback: "None: the agent needs Muse Spark" },
  { key: "vision", what: "Room photo → structured scene (json_schema)", endpoint: "POST /v1/chat/completions + image_url", fallback: "Ask the user to describe the room in text" },
  { key: "segmentation", what: "Outline haze, windows, purifier", endpoint: "POST /v1/responses (SAM 3.1)", fallback: "Muse Spark grounding boxes" },
  { key: "transcribe", what: "Push-to-talk voice", endpoint: "POST /v1/asr/transcribe", fallback: "Browser Web Speech dictation" },
  { key: "image", what: "Shareable air-today card art", endpoint: "POST /v1/images/generations", fallback: "Teal gradient card" },
];

/** Live status of every Meta Model API capability this deployment uses, plus this conversation's totals. */
export function JudgePanel({ totals, onClose }: { totals: TraceTotals; onClose: () => void }) {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/capabilities", { cache: "no-store" })
      .then((r) => r.json() as Promise<Caps>)
      .then((c) => alive && setCaps(c))
      .catch(() => alive && setErr("Couldn't reach /api/capabilities"));
    return () => {
      alive = false;
    };
  }, []);
  const model = (k: string) => caps?.modelIds?.[k] ?? "";
  return (
    <section className="judge-panel" aria-label="Judge mode: live system telemetry">
      <header>
        <span className="kicker">Judge mode</span>
        <p>Everything here is live: no seeded data, no canned replies. Capabilities are read from the Meta Model API&apos;s model list.</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
          Exit judge mode
        </button>
      </header>
      <div className="judge-table-wrap">
        <table className="judge-table">
          <caption className="sr-only">Meta Model API capabilities</caption>
          <thead>
            <tr>
              <th scope="col">Capability</th>
              <th scope="col">Model</th>
              <th scope="col">Endpoint</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => {
              const live = caps?.features?.[r.key];
              return (
                <tr key={r.key}>
                  <td>{r.what}</td>
                  <td>
                    <code>{model(r.key)}</code>
                  </td>
                  <td>
                    <code>{r.endpoint}</code>
                  </td>
                  <td data-live={caps ? String(Boolean(live)) : "checking"}>
                    {!caps ? (err ?? "Checking…") : live ? "Live" : `Fallback: ${r.fallback}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="judge-totals">
        This conversation: {totals.steps} reasoning steps · {totals.toolCalls} tool calls · Muse Spark time {fmtMs(totals.modelMs)} ·{" "}
        {fmtTokens(totals.reasoningTokens)} reasoning / {fmtTokens(totals.promptTokens + totals.completionTokens)} total tokens
        {caps && <> · capabilities checked {new Date(caps.checkedAt).toLocaleTimeString()}</>}
      </p>
    </section>
  );
}
