import { fmtClock, type AirTwin } from "@/lib/airTwin";
import { fmtNum } from "../format";

/** Headline for the twin, e.g. "Below 9 µg/m³ by 19:40". */
export function twinHeadline(t: AirTwin): string {
  const target = `${fmtNum(t.targetPm25, 0)} µg/m³`;
  if (t.minutesToTarget === 0) return `Already below ${target}`;
  if (t.minutesToTarget === null || !t.belowTargetAtIso) {
    return `Levels off near ${fmtNum(t.planSteadyPm25, 0)} µg/m³, above ${target}: needs more CADR or less leakage`;
  }
  return `Below ${target} by ${fmtClock(t.belowTargetAtIso, t.timezone)} (~${t.minutesToTarget} min)`;
}

/** Before/after "air twin": modelled indoor PM2.5 as-is vs with the plan. */
export function AirTwinChart({ twin, width = 320, height = 150 }: { twin: AirTwin; width?: number; height?: number }) {
  const padL = 30;
  const padR = 8;
  const padT = 10;
  const padB = 20;
  const n = twin.withPlan.length;
  const maxY = Math.max(...twin.asIs, ...twin.withPlan, twin.targetPm25) * 1.1 || 1;
  const x = (i: number) => padL + (i / Math.max(1, n - 1)) * (width - padL - padR);
  const y = (v: number) => padT + (1 - v / maxY) * (height - padT - padB);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const minutes = (n - 1) * twin.stepMin;
  const ticks = [0, 0.5, 1].map((f) => Math.round((f * minutes) / twin.stepMin));
  const tickLabel = (i: number) => fmtClock(new Date(new Date(twin.startIso).getTime() + i * twin.stepMin * 60_000).toISOString(), twin.timezone);
  const hitIdx =
    twin.minutesToTarget !== null && twin.minutesToTarget > 0 && twin.minutesToTarget <= minutes
      ? twin.minutesToTarget / twin.stepMin
      : null;
  const a = twin.assumptions;
  const summary = `Model: indoor PM2.5 as-is stays near ${fmtNum(twin.asIsSteadyPm25, 0)} µg/m³; with the plan it falls toward ${fmtNum(twin.planSteadyPm25, 0)} µg/m³. ${twinHeadline(twin)}.`;

  return (
    <figure className="air-twin" data-testid="air-twin">
      <figcaption className="air-twin-head">
        <strong>{twinHeadline(twin)}</strong>
        <span className="badge" data-tone="info">
          Model, not a measurement
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={summary}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={width - padR} y1={y(maxY * f)} y2={y(maxY * f)} className="air-twin-grid" />
            <text x={padL - 4} y={y(maxY * f) + 3} textAnchor="end" className="air-twin-axis">
              {fmtNum(maxY * f, 0)}
            </text>
          </g>
        ))}
        {ticks.map((i) => (
          <text key={i} x={x(i)} y={height - 5} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="air-twin-axis">
            {tickLabel(i)}
          </text>
        ))}
        <line x1={padL} x2={width - padR} y1={y(twin.targetPm25)} y2={y(twin.targetPm25)} className="air-twin-target" />
        <text x={width - padR} y={y(twin.targetPm25) - 4} textAnchor="end" className="air-twin-axis">
          target {fmtNum(twin.targetPm25, 0)}
        </text>
        <path d={path(twin.asIs)} className="air-twin-asis" />
        <path d={path(twin.withPlan)} className="air-twin-plan" />
        {hitIdx !== null && (
          <g>
            <line x1={x(hitIdx)} x2={x(hitIdx)} y1={padT} y2={height - padB} className="air-twin-marker" />
            <circle cx={x(hitIdx)} cy={y(twin.targetPm25)} r="4" className="air-twin-dot" />
          </g>
        )}
      </svg>
      <div className="air-twin-legend" aria-hidden="true">
        <span className="swatch asis" /> As-is (no purifier, normal airing)
        <span className="swatch plan" /> With the plan
      </div>
      <details className="air-twin-assumptions">
        <summary>Assumptions</summary>
        <ul className="list">
          <li>
            Outdoor PM2.5 {fmtNum(twin.outdoorPm25, 0)} µg/m³ held constant; start {fmtNum(twin.startPm25, 0)} µg/m³ (
            {twin.startSource === "measured_indoor" ? "your indoor reading" : "modelled from outdoor, as-is"}).
          </li>
          <li>
            Room {fmtNum(twin.roomVolumeM3, 0)} m³, purifier at the required CADR {fmtNum(twin.cadrM3h, 0)} m³/h (
            {fmtNum(twin.cadrM3h / twin.roomVolumeM3, 1)} air changes/h).
          </li>
          <li>
            Air exchange {a.asIsAirExchangePerH}/h as-is, {a.sealedInfiltrationPerH}/h sealed; penetration {a.penetration}; deposition{" "}
            {a.depositionPerH}/h; well-mixed single room, no indoor sources (cooking or smoke push it up).
          </li>
        </ul>
      </details>
    </figure>
  );
}
