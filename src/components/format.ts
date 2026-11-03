import type { AqiCategory } from "@/lib/domain";

export type Tone = "ok" | "watch" | "act" | "urgent" | "info" | "approval" | "danger" | undefined;

export function categoryTone(cat: AqiCategory | string | undefined): Tone {
  switch (cat) {
    case "good":
      return "ok";
    case "moderate":
      return "watch";
    case "unhealthy_sensitive":
    case "unhealthy":
      return "act";
    case "very_unhealthy":
    case "hazardous":
      return "danger";
    default:
      return undefined;
  }
}

export const humanize = (s: string) => s.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

export const POLLUTANT_LABEL: Record<string, string> = {
  pm25: "PM2.5",
  pm10: "PM10",
  pm1: "PM1",
  no2: "NO₂",
  o3: "O₃",
  so2: "SO₂",
  co: "CO",
  no: "NO",
  nox: "NOₓ",
  bc: "Black carbon",
};

/** Time in the viewer's own zone, with the zone label. */
export function fmtTime(iso?: string | null, withDate = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function fmtNum(n: number | undefined | null, digits = 1): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}
