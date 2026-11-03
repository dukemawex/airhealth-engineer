import { useId } from "react";
import {
  LOGO_COLORS,
  LOGO_FLOW_PATHS,
  LOGO_PLUS_PATH,
  LOGO_PLUS_STROKE_WIDTH,
  LOGO_STROKE_WIDTH,
  LOGO_TILE,
  LOGO_VIEWBOX,
} from "./logoGeometry";

/** AirHealth Engineer mark. Geometry lives in logoGeometry.ts (single source of truth). */
export function Logo({ size = 32, title }: { size?: number; title?: string }) {
  const gid = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox={LOGO_VIEWBOX}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={LOGO_COLORS.tileFrom} />
          <stop offset="1" stopColor={LOGO_COLORS.tileTo} />
        </linearGradient>
      </defs>
      <rect width={LOGO_TILE.width} height={LOGO_TILE.height} rx={LOGO_TILE.rx} fill={`url(#${gid})`} />
      {LOGO_FLOW_PATHS.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={LOGO_COLORS.stroke}
          strokeWidth={LOGO_STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      <path d={LOGO_PLUS_PATH} fill="none" stroke={LOGO_COLORS.accent} strokeWidth={LOGO_PLUS_STROKE_WIDTH} strokeLinecap="round" />
    </svg>
  );
}
