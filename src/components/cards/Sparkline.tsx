/** Tiny inline trend of real PM2.5 readings recorded for this conversation. */
export function Sparkline({
  points,
  width = 160,
  height = 36,
  label,
}: {
  points: Array<{ at: string; pm25?: number }>;
  width?: number;
  height?: number;
  label: string;
}) {
  const vals = points.filter((p): p is { at: string; pm25: number } => typeof p.pm25 === "number");
  if (vals.length < 2) {
    return <span className="card-sub">Trend appears after the next re-check.</span>;
  }
  const ys = vals.map((v) => v.pm25);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const pad = 3;
  const step = (width - pad * 2) / (vals.length - 1);
  const coords = vals.map((v, i) => [pad + i * step, height - pad - ((v.pm25 - min) / span) * (height - pad * 2)] as const);
  const d = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1]!;
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="3" fill="currentColor" />
    </svg>
  );
}
