import { INDOOR_VENT_MODES, type DeviceCommand, type EngineeringChecks, type InterventionDesign } from "@/lib/domain";
import { INDOOR_ONLY_DEVICES, isOpenSpace, notApplicableNote, SPACE_LABEL, type SpaceType } from "@/lib/space";
import { fmtNum, humanize } from "../format";
import { AirTwinChart } from "./AirTwinChart";

const MODE_LABEL: Record<string, string> = {
  open_dispersion: "Open dispersion",
  stay_upwind: "Stay upwind",
  reduce_source: "Reduce the source",
  open_air_dispersion: "Open-air dispersion",
};
const modeLabel = (m: string) => MODE_LABEL[m] ?? humanize(m);

/**
 * Exposure steps for a design. Older stored plans used `healthPrecautions`;
 * they render under the same neutral heading.
 */
export function exposureStepsOf(design: Partial<InterventionDesign>): string[] {
  const legacy = (design as { healthPrecautions?: unknown }).healthPrecautions;
  return design.exposureSteps ?? (Array.isArray(legacy) ? legacy.filter((x): x is string => typeof x === "string") : []);
}

/**
 * What the card may show for a space. Enforced here too, so a plan stored before
 * the space rules (or a raw model draft) never shows indoor sizing outdoors.
 */
export function planView(design: Partial<InterventionDesign>, checks?: EngineeringChecks) {
  const space: SpaceType = checks?.space ?? design.space ?? "indoor";
  const open = isOpenSpace(space);
  const indoorModes = new Set<string>(INDOOR_VENT_MODES);
  const indoorDevices = new Set<string>(INDOOR_ONLY_DEVICES);
  const schedule = (design.ventilation?.schedule ?? []).flatMap((s) =>
    !open || !indoorModes.has(s.mode)
      ? [s]
      : s.mode === "windows_open" || s.mode === "purge"
        ? [{ ...s, mode: "open_dispersion" as const, freshAirPercent: undefined }]
        : [],
  );
  return {
    space,
    open,
    showSizing: !open,
    notApplicable: open ? (checks?.notApplicable?.[0] ?? notApplicableNote(space)) : undefined,
    strategy: open ? "open_air_dispersion" : design.ventilation?.strategy,
    schedule,
    deviceCommands: (design.deviceCommands ?? []).filter((c) => !open || !indoorDevices.has(c.deviceType)),
    exposureSteps: exposureStepsOf(design),
    // The air twin models an enclosed room only.
    airTwin: open ? undefined : checks?.airTwin,
  };
}

export function describeCommand(c: DeviceCommand): string {
  const extras = Object.entries(c)
    .filter(([k]) => !["deviceType", "deviceId", "action"].includes(k))
    .map(([k, v]) => `${k}=${String(v)}`);
  return `${humanize(c.deviceType)} ${c.deviceId}: ${humanize(c.action)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

export function InterventionPlanCard({
  design,
  checks,
  status,
}: {
  design: Partial<InterventionDesign>;
  checks?: EngineeringChecks;
  status?: string;
}) {
  const f = design.filtration;
  const v = design.ventilation;
  const view = planView(design, checks);
  return (
    <section className="card" aria-label={`Intervention plan: ${design.title ?? "untitled"}`}>
      <div className="card-header">
        <div>
          <span className="kicker">Intervention plan</span>
          <h3 className="card-title">{design.title ?? "Intervention plan"}</h3>
          {design.objective && <p className="card-standfirst">{design.objective}</p>}
        </div>
        <div className="badge-row">
          {view.open && (
            <span className="badge" data-tone="watch">
              {SPACE_LABEL[view.space]}
            </span>
          )}
          {status && (
            <span className="badge" data-tone={status === "active" ? "ok" : "info"}>
              {humanize(status)}
            </span>
          )}
        </div>
      </div>

      {design.riskSummary && (
        <div className="card-section">
          <h4>Why</h4>
          <p style={{ fontSize: "var(--text-sm)" }}>{design.riskSummary}</p>
        </div>
      )}

      {view.open ? (
        <div className="card-section" data-testid="sizing-not-applicable">
          <h4>Purifier sizing</h4>
          <p className="card-sub">{view.notApplicable}</p>
        </div>
      ) : (
        (f || checks) && (
          <div className="card-section">
            <h4>Filtration</h4>
            <dl className="kv">
              {f && (
                <>
                  <dt>Filter</dt>
                  <dd>{humanize(f.recommendedFilterClass)}</dd>
                </>
              )}
              {checks?.targetAirChangesPerHour !== undefined && (
                <>
                  <dt>Target</dt>
                  <dd>{fmtNum(checks.targetAirChangesPerHour)} air changes / hour</dd>
                </>
              )}
              {checks?.requiredCadrM3h !== undefined && (
                <>
                  <dt>Required CADR</dt>
                  <dd>
                    {fmtNum(checks.requiredCadrM3h, 0)} m³/h ({fmtNum(checks.requiredCadrCfm, 0)} CFM)
                    {checks.roomVolumeM3 !== undefined ? ` for ${fmtNum(checks.roomVolumeM3, 0)} m³` : ""}
                  </dd>
                </>
              )}
              {f?.purifierFanSetting && (
                <>
                  <dt>Fan</dt>
                  <dd>{f.purifierFanSetting}</dd>
                </>
              )}
            </dl>
            {f?.notes && <p className="card-sub">{f.notes}</p>}
          </div>
        )
      )}

      {view.airTwin && (
        <div className="card-section">
          <h4>Air twin · before / after</h4>
          <AirTwinChart twin={view.airTwin} />
        </div>
      )}

      {v && (
        <div className="card-section">
          <h4>
            {view.open ? "Airflow" : "Ventilation"} · {modeLabel(view.strategy ?? v.strategy)}
          </h4>
          {view.schedule.length > 0 && (
            <table className="schedule">
              <caption className="sr-only">{view.open ? "Airflow" : "Ventilation"} schedule (local time)</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {view.schedule.map((s, i) => (
                  <tr key={`${s.start}-${i}`}>
                    <td>
                      {s.start}–{s.end}
                    </td>
                    <td>
                      {modeLabel(s.mode)}
                      {s.freshAirPercent !== undefined ? ` · ${s.freshAirPercent}% fresh air` : ""}
                    </td>
                    <td>{s.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {v.notes && <p className="card-sub">{v.notes}</p>}
        </div>
      )}

      {design.routeAlternatives && design.routeAlternatives.length > 0 && (
        <div className="card-section">
          <h4>Safer routes &amp; timing</h4>
          <ul className="list">
            {design.routeAlternatives.map((r, i) => (
              <li key={i}>
                {r.description}
                {r.recommendedTimeWindow ? ` · ${r.recommendedTimeWindow}` : ""}
                {r.estimatedExposureReductionPercent !== undefined ? ` · ~${r.estimatedExposureReductionPercent}% less exposure` : ""}
                {r.avoid?.length ? <span className="card-sub"> Avoid: {r.avoid.join(", ")}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.deviceCommands.length > 0 && (
        <div className="card-section">
          <h4>Proposed device actions (each needs your approval)</h4>
          <ul className="list">
            {view.deviceCommands.map((c, i) => (
              <li key={i}>{describeCommand(c)}</li>
            ))}
          </ul>
        </div>
      )}

      {view.exposureSteps.length > 0 && (
        <div className="card-section">
          <h4>Exposure steps</h4>
          <ul className="list">
            {view.exposureSteps.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {checks?.warnings && checks.warnings.length > 0 && (
        <div className="card-section" role="note">
          <h4>Engineering checks</h4>
          <ul className="list">
            {checks.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {design.monitoringPlan && (
        <p className="card-sub">Re-check every {design.monitoringPlan.recheckIntervalMinutes} min.</p>
      )}
    </section>
  );
}
