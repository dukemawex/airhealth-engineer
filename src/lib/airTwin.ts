/**
 * "Air twin": a single-zone, well-mixed mass-balance model of indoor PM2.5.
 *
 *   dC/dt = λ·P·C_out − (λ + k + CADR/V)·C
 *
 * λ air exchange with outdoors (1/h), P particle penetration, k indoor deposition
 * (1/h), CADR/V purifier air changes (1/h). Closed form:
 *   C(t) = C_ss + (C0 − C_ss)·e^(−L·t),  L = λ + k + CADR/V,  C_ss = λ·P·C_out / L
 *
 * It is a MODEL, not a measurement: it shows the shape and timing the plan should
 * produce under stated assumptions. Pure and client-safe.
 */

export interface AirTwinAssumptions {
  /** Air exchange as things are now (doors/windows used normally), 1/h. */
  asIsAirExchangePerH: number;
  /** Infiltration with the plan (windows and doors closed), 1/h. */
  sealedInfiltrationPerH: number;
  /** Fraction of outdoor PM2.5 that gets through the building shell. */
  penetration: number;
  /** Indoor deposition onto surfaces, 1/h. */
  depositionPerH: number;
}

export const DEFAULT_TWIN_ASSUMPTIONS: AirTwinAssumptions = {
  asIsAirExchangePerH: 1.5,
  sealedInfiltrationPerH: 0.5,
  penetration: 0.8,
  depositionPerH: 0.2,
};

export interface AirTwinInput {
  outdoorPm25: number;
  roomVolumeM3: number;
  cadrM3h: number;
  targetPm25: number;
  /** Measured indoor PM2.5 if the user shared one; otherwise the as-is steady state is used. */
  indoorPm25?: number;
  startIso: string;
  timezone?: string;
  horizonMin?: number;
  stepMin?: number;
  assumptions?: Partial<AirTwinAssumptions>;
}

export interface AirTwin {
  kind: "model";
  startIso: string;
  timezone?: string;
  outdoorPm25: number;
  startPm25: number;
  startSource: "measured_indoor" | "modelled_as_is";
  targetPm25: number;
  roomVolumeM3: number;
  cadrM3h: number;
  assumptions: AirTwinAssumptions;
  stepMin: number;
  /** PM2.5 every stepMin minutes from start, as things are now (no purifier, normal airing). */
  asIs: number[];
  /** PM2.5 every stepMin minutes with the plan (sealed, purifier at the sized CADR). */
  withPlan: number[];
  asIsSteadyPm25: number;
  planSteadyPm25: number;
  /** Minutes until the plan curve is at or below target; 0 if already below; null if never. */
  minutesToTarget: number | null;
  /** ISO time the plan reaches target, when it does. */
  belowTargetAtIso: string | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function curve(c0: number, cOut: number, lambda: number, a: AirTwinAssumptions, purifierAch: number) {
  const L = lambda + a.depositionPerH + purifierAch;
  const css = (lambda * a.penetration * cOut) / L;
  return { L, css, at: (tMin: number) => css + (c0 - css) * Math.exp((-L * tMin) / 60) };
}

export function simulateAirTwin(input: AirTwinInput): AirTwin | null {
  const { outdoorPm25: cOut, roomVolumeM3: V, cadrM3h, targetPm25 } = input;
  if (!(cOut >= 0) || !(V > 0) || !(cadrM3h > 0) || !(targetPm25 > 0)) return null;
  const a: AirTwinAssumptions = { ...DEFAULT_TWIN_ASSUMPTIONS, ...input.assumptions };
  const horizon = input.horizonMin ?? 180;
  const step = input.stepMin ?? 5;

  const asIsSteady = curve(0, cOut, a.asIsAirExchangePerH, a, 0).css;
  const measured = input.indoorPm25 !== undefined && input.indoorPm25 >= 0;
  const c0 = measured ? input.indoorPm25! : asIsSteady;

  const asIs = curve(c0, cOut, a.asIsAirExchangePerH, a, 0);
  const plan = curve(c0, cOut, a.sealedInfiltrationPerH, a, cadrM3h / V);

  const n = Math.floor(horizon / step) + 1;
  const series = (f: (t: number) => number) => Array.from({ length: n }, (_, i) => r1(f(i * step)));

  let minutesToTarget: number | null;
  if (c0 <= targetPm25) minutesToTarget = 0;
  else if (plan.css >= targetPm25) minutesToTarget = null;
  else minutesToTarget = Math.ceil((-Math.log((targetPm25 - plan.css) / (c0 - plan.css)) / plan.L) * 60);

  return {
    kind: "model",
    startIso: input.startIso,
    timezone: input.timezone,
    outdoorPm25: r1(cOut),
    startPm25: r1(c0),
    startSource: measured ? "measured_indoor" : "modelled_as_is",
    targetPm25,
    roomVolumeM3: V,
    cadrM3h,
    assumptions: a,
    stepMin: step,
    asIs: series(asIs.at),
    withPlan: series(plan.at),
    asIsSteadyPm25: r1(asIs.css),
    planSteadyPm25: r1(plan.css),
    minutesToTarget,
    belowTargetAtIso:
      minutesToTarget === null ? null : new Date(new Date(input.startIso).getTime() + minutesToTarget * 60_000).toISOString(),
  };
}

/** Indoor PM2.5 target: 9 µg/m³ (US AQI "Good" limit) for sensitive groups, else 15 µg/m³ (WHO 24-h guideline). */
export const twinTarget = (sensitive: boolean) => (sensitive ? 9 : 15);

/** HH:MM in the place's time zone (falls back to the viewer's zone). */
export function fmtClock(iso: string, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: timezone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-GB", opts).format(new Date(iso));
  }
}
