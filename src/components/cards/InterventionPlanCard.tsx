import type { DeviceCommand, EngineeringChecks, InterventionDesign } from "@/lib/domain";
import { fmtNum, humanize } from "../format";

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
  return (
    <section className="card" aria-label={`Intervention plan: ${design.title ?? "untitled"}`}>
      <div className="card-header">
        <div>
          <span className="kicker">Intervention plan</span>
          <h3 className="card-title">{design.title ?? "Intervention plan"}</h3>
          {design.objective && <p className="card-standfirst">{design.objective}</p>}
        </div>
        {status && (
          <span className="badge" data-tone={status === "active" ? "ok" : "info"}>
            {humanize(status)}
          </span>
        )}
      </div>

      {design.riskSummary && (
        <div className="card-section">
          <h4>Why</h4>
          <p style={{ fontSize: "var(--text-sm)" }}>{design.riskSummary}</p>
        </div>
      )}

      {(f || checks) && (
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
      )}

      {v && (
        <div className="card-section">
          <h4>Ventilation · {humanize(v.strategy)}</h4>
          {v.schedule && v.schedule.length > 0 && (
            <table className="schedule">
              <caption className="sr-only">Ventilation schedule (local time)</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {v.schedule.map((s, i) => (
                  <tr key={`${s.start}-${i}`}>
                    <td>
                      {s.start}–{s.end}
                    </td>
                    <td>
                      {humanize(s.mode)}
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

      {design.deviceCommands && design.deviceCommands.length > 0 && (
        <div className="card-section">
          <h4>Proposed device actions (each needs your approval)</h4>
          <ul className="list">
            {design.deviceCommands.map((c, i) => (
              <li key={i}>{describeCommand(c)}</li>
            ))}
          </ul>
        </div>
      )}

      {design.healthPrecautions && design.healthPrecautions.length > 0 && (
        <div className="card-section">
          <h4>Health precautions</h4>
          <ul className="list">
            {design.healthPrecautions.map((p, i) => (
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
