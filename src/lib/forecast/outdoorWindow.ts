/**
 * Deterministic "best time to be outside" pick from the hourly CAMS forecast.
 * Hours are local wall-clock strings ("2026-11-03T14:00"), already starting at "now".
 * Exercise, a walk or a commute only make sense in daylight-ish hours, so we search
 * DAY_START..DAY_END on today and the next day, pick the cleanest contiguous block,
 * and prefer today unless today has nothing under the person's threshold.
 */
export interface OutdoorHour {
  t: string;
  pm25: number | null;
}

export interface OutdoorWindow {
  startLocal: string;
  endLocal: string;
  /** "today" | "tomorrow" | weekday ("Thu"). */
  day: string;
  avgPm25: number;
  maxPm25: number;
  thresholdPm25: number;
  withinThreshold: boolean;
  /** One-line, ready to quote: "Best window: today 07:00–09:00 (PM2.5 ~11 µg/m³, forecast)". */
  summary: string;
}

const DAY_START = 6;
const DAY_END = 20; // window must end by 20:00

const hourOf = (t: string) => Number(t.slice(11, 13));
const dateOf = (t: string) => t.slice(0, 10);

function plusHours(t: string, n: number): string {
  const d = new Date(`${t}:00Z`);
  if (Number.isNaN(d.getTime())) return t;
  d.setUTCHours(d.getUTCHours() + n);
  return d.toISOString().slice(0, 16);
}

function dayLabel(date: string, today: string): string {
  if (date === today) return "today";
  if (date === dateOf(plusHours(`${today}T12:00`, 24))) return "tomorrow";
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
}

export function bestOutdoorWindow(
  hours: OutdoorHour[],
  opts: { thresholdPm25?: number; durationHours?: number; maxDays?: number } = {},
): OutdoorWindow | null {
  const threshold = opts.thresholdPm25 ?? 35.4;
  const len = Math.max(1, Math.min(4, Math.round(opts.durationHours ?? 2)));
  const maxDays = opts.maxDays ?? 2;
  if (!hours.length) return null;
  const today = dateOf(hours[0]!.t);
  const days: string[] = [];
  for (const h of hours) if (!days.includes(dateOf(h.t))) days.push(dateOf(h.t));
  const allowed = new Set(days.slice(0, maxDays));

  type Cand = { i: number; avg: number; max: number; date: string };
  const cands: Cand[] = [];
  for (let i = 0; i + len <= hours.length; i++) {
    const block = hours.slice(i, i + len);
    const first = block[0]!;
    const date = dateOf(first.t);
    if (!allowed.has(date)) continue;
    // Contiguous, same day, inside daylight hours, all values present.
    if (block.some((h, k) => h.t !== plusHours(first.t, k) || h.pm25 === null)) continue;
    if (hourOf(first.t) < DAY_START || hourOf(first.t) + len > DAY_END) continue;
    const vals = block.map((h) => h.pm25 as number);
    cands.push({ i, avg: vals.reduce((a, b) => a + b, 0) / len, max: Math.max(...vals), date });
  }
  if (!cands.length) return null;
  const best = (list: Cand[]) => list.reduce((a, b) => (b.avg < a.avg - 0.05 ? b : a));
  const todays = cands.filter((c) => c.date === today);
  let pick = todays.length ? best(todays) : best(cands);
  if (pick.max > threshold) {
    const under = cands.filter((c) => c.max <= threshold);
    if (under.length) pick = under[0]!.date === today ? best(under.filter((c) => c.date === today)) : best(under.filter((c) => c.date === under[0]!.date));
    else pick = best(cands);
  }
  const start = hours[pick.i]!.t;
  const end = plusHours(start, len);
  const avg = Math.round(pick.avg * 10) / 10;
  const day = dayLabel(pick.date, today);
  const within = pick.max <= threshold;
  return {
    startLocal: start,
    endLocal: end,
    day,
    avgPm25: avg,
    maxPm25: Math.round(pick.max * 10) / 10,
    thresholdPm25: threshold,
    withinThreshold: within,
    summary: `Best window: ${day} ${start.slice(11, 16)}–${end.slice(11, 16)} (PM2.5 ~${Math.round(avg)} µg/m³, forecast${within ? "" : `; still above your ${threshold} µg/m³ threshold, so keep it light and short`})`,
  };
}
