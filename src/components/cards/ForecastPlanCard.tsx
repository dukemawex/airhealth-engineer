"use client";

import { useState } from "react";
import type { DeviceCommand } from "@/lib/domain";
import { describeCommand } from "./InterventionPlanCard";

export interface ForecastPlanOutput {
  forecast: { location: { name: string }; timezone: string; sourceNote: string; hours: Array<{ t: string; pm25: number | null; aqi: number | null }> };
  plan: {
    headline: string;
    steps: Array<{ id: string; startLocal: string; endLocal: string; title: string; why: string; risk: "low" | "moderate" | "high" | "very_high"; command: DeviceCommand | null }>;
  };
  planner: { kind: "muse-spark"; model: string; reasoningEffort: string; ms: number; reasoningTokens: number | null } | { kind: "rules-fallback"; reason: string };
}

const RISK_LABEL = { low: "Low", moderate: "Moderate", high: "High", very_high: "Very high" } as const;

/** "2026-11-03T14:00" -> "Tue 14:00" (the string is already local to the place). */
export function fmtLocal(s: string): string {
  const d = new Date(`${s}:00Z`);
  if (Number.isNaN(d.getTime())) return s;
  const day = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  return `${day} ${s.slice(11, 16)}`;
}

export function applyStepMessage(step: ForecastPlanOutput["plan"]["steps"][number]): string {
  return `Apply forecast step "${step.title}" (${fmtLocal(step.startLocal)} to ${fmtLocal(step.endLocal)}) now: call executeDeviceAction with exactly this command ${JSON.stringify(step.command)}`;
}

function Chart({ hours, steps }: { hours: ForecastPlanOutput["forecast"]["hours"]; steps: ForecastPlanOutput["plan"]["steps"] }) {
  const W = 640;
  const H = 150;
  const pad = { l: 34, r: 8, t: 10, b: 22 };
  const vals = hours.map((h) => h.pm25 ?? 0);
  const max = Math.max(40, ...vals) * 1.1;
  const n = Math.max(1, hours.length - 1);
  const x = (i: number) => pad.l + (i / n) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const idx = (t: string) => {
    const i = hours.findIndex((h) => h.t >= t);
    return i < 0 ? hours.length - 1 : i;
  };
  const line = hours.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(h.pm25 ?? 0).toFixed(1)}`).join("");
  const area = `${line}L${x(hours.length - 1).toFixed(1)},${y(0)}L${x(0)},${y(0)}Z`;
  const days = hours.flatMap((h, i) => (h.t.endsWith("T00:00") ? [{ i, label: fmtLocal(h.t).slice(0, 3) }] : []));
  const peak = vals.indexOf(Math.max(...vals));
  return (
    <svg className="fc-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`PM2.5 forecast, peak ${vals[peak] ?? "n/a"} µg/m³ at ${hours[peak] ? fmtLocal(hours[peak].t) : "n/a"}`}>
      <defs>
        <linearGradient id="fcFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {steps.map((s) => (
        <rect key={s.id} className="fc-band" data-risk={s.risk} x={x(idx(s.startLocal))} y={pad.t} width={Math.max(2, x(idx(s.endLocal)) - x(idx(s.startLocal)))} height={H - pad.t - pad.b} />
      ))}
      {[12, 35.4, 55.4].filter((v) => v < max).map((v) => (
        <g key={v}>
          <line className="fc-grid" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
          <text className="fc-axis" x={pad.l - 4} y={y(v) + 3} textAnchor="end">{v}</text>
        </g>
      ))}
      {days.map((d) => (
        <g key={d.i}>
          <line className="fc-grid" x1={x(d.i)} x2={x(d.i)} y1={pad.t} y2={H - pad.b} />
          <text className="fc-axis" x={x(d.i) + 3} y={H - 6}>{d.label}</text>
        </g>
      ))}
      <path d={area} fill="url(#fcFill)" />
      <path d={line} className="fc-line" />
      {hours[peak] && <circle cx={x(peak)} cy={y(vals[peak]!)} r={4} className="fc-peak" />}
    </svg>
  );
}

export function ForecastPlanCard({ output, onApplyStep, busy }: { output: ForecastPlanOutput; onApplyStep?: (text: string) => void; busy?: boolean }) {
  const [sent, setSent] = useState<Record<string, true>>({});
  const { forecast, plan, planner } = output;
  return (
    <section className="card fc-card" aria-label="72-hour forecast plan">
      <div className="card-header">
        <div>
          <span className="kicker">72-h CAMS forecast plan · {forecast.location.name}</span>
          <h3 className="card-title">{plan.headline}</h3>
        </div>
        <span className="badge" data-tone={planner.kind === "muse-spark" ? "ok" : "act"} title={planner.kind === "muse-spark" ? `${planner.model}, reasoning ${planner.reasoningEffort}, ${(planner.ms / 1000).toFixed(1)} s` : planner.reason}>
          {planner.kind === "muse-spark" ? `Muse Spark · ${planner.reasoningEffort}` : "Rules fallback"}
        </span>
      </div>
      {forecast.hours.length > 1 && <Chart hours={forecast.hours} steps={plan.steps} />}
      <ol className="fc-steps">
        {plan.steps.map((s) => (
          <li key={s.id} className="fc-step" data-risk={s.risk}>
            <div className="fc-when">
              <time dateTime={s.startLocal}>{fmtLocal(s.startLocal)}</time>
              <span aria-hidden="true">→</span>
              <time dateTime={s.endLocal}>{fmtLocal(s.endLocal)}</time>
              <span className="fc-risk">{RISK_LABEL[s.risk]}</span>
            </div>
            <strong className="fc-title">{s.title}</strong>
            <p className="fc-why">{s.why}</p>
            {s.command ? (
              <div className="fc-action">
                <code className="command">{describeCommand(s.command)}</code>
                {onApplyStep && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy || !!sent[s.id]}
                    onClick={() => {
                      setSent((m) => ({ ...m, [s.id]: true }));
                      onApplyStep(applyStepMessage(s));
                    }}
                    aria-label={`Approve step: ${s.title}`}
                  >
                    {sent[s.id] ? "Sent for approval" : "Approve step"}
                  </button>
                )}
              </div>
            ) : (
              <span className="fc-noop">No device change: behaviour step</span>
            )}
          </li>
        ))}
      </ol>
      <p className="card-sub">
        Times are local to {forecast.location.name} ({forecast.timezone}). {forecast.sourceNote} Each device step still asks for your confirmation before anything runs. Not medical advice.
      </p>
    </section>
  );
}
