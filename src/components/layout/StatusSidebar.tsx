"use client";

import type { StatusReport } from "@/lib/agent/status";
import type { AirQualitySnapshot } from "@/lib/domain";
import { AirQualityCard } from "../cards/AirQualityCard";
import { HealthContextSummary } from "../cards/HealthContextSummary";
import { describeCommand } from "../cards/InterventionPlanCard";
import { fmtTime, humanize } from "../format";

const LEVEL_TONE: Record<string, string | undefined> = { ok: "ok", watch: "watch", act: "act", urgent: "urgent" };

export function StatusSidebar({
  status,
  loading,
  error,
  open,
  onClose,
  onRecheck,
  rechecking,
}: {
  status: StatusReport | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  onClose: () => void;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const c = status?.combined;
  return (
    <aside id="status-panel" className="sidebar" data-open={open} aria-label="Health-engineering status">
      <div className="card-header">
        <h2 className="panel-title">Health-engineering status</h2>
        <button type="button" className="btn btn-ghost icon-btn sidebar-close" onClick={onClose} aria-label="Close status panel">
          ✕
        </button>
      </div>

      {error && (
        <div className="banner" data-tone="warning" role="status">
          {error}
        </div>
      )}

      {!status && loading && (
        <div className="panel" aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" style={{ width: "60%" }} />
          <div className="skeleton" style={{ width: "80%" }} />
        </div>
      )}

      {!status && !loading && (
        <p className="sidebar-empty">
          Nothing to show yet. Share your location and health context to start; live status appears here.
        </p>
      )}

      {status && c && (
        <>
          <div className="status-hero" data-level={c.level} aria-live="polite">
            <div className="card-header">
              <span className="status-headline">{c.headline}</span>
              <span className="badge" data-tone={LEVEL_TONE[c.level]}>
                {humanize(c.level)}
              </span>
            </div>
            {c.reasons.length > 0 && (
              <ul className="list">
                {c.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>

          <nav className="panel" aria-label="Journey">
            <h3 className="panel-title">Journey</h3>
            <ol className="journey">
              {c.steps.map((s) => (
                <li key={s.key} data-done={s.done}>
                  <span className="dot" aria-hidden="true">
                    {s.done ? "✓" : ""}
                  </span>
                  <span>
                    {s.label}
                    <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
                    {s.detail && <span className="detail">{s.key === "monitoring" && status.monitoring?.lastCheckAt ? `Last check ${fmtTime(status.monitoring.lastCheckAt, true)}` : s.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </nav>

          {status.airQuality && (
            <div className="panel">
              <h3 className="panel-title">Air quality</h3>
              <AirQualityCard snapshot={status.airQuality as AirQualitySnapshot} history={status.airQualityHistory} />
              <button type="button" className="btn btn-secondary btn-sm" onClick={onRecheck} disabled={rechecking}>
                {rechecking ? "Re-checking…" : "Re-check now"}
              </button>
              {status.monitoring?.lastError && <p className="card-sub">Last re-check problem: {status.monitoring.lastError}</p>}
            </div>
          )}

          {status.profileSummary && (
            <div className="panel">
              <h3 className="panel-title">Health context</h3>
              <HealthContextSummary profile={status.profileSummary} assessment={status.healthAssessment} compact />
            </div>
          )}

          <div className="panel">
            <h3 className="panel-title">Interventions</h3>
            {status.interventions.length === 0 ? (
              <p className="sidebar-empty">No intervention designed yet.</p>
            ) : (
              status.interventions.map((i) => (
                <div key={i.id} className="card">
                  <div className="card-header">
                    <span className="card-title">{i.title}</span>
                    <span className="badge" data-tone={i.status === "active" ? "ok" : "info"}>
                      {humanize(i.status)}
                    </span>
                  </div>
                  <dl className="kv">
                    <dt>Filter</dt>
                    <dd>{humanize(i.filterClass)}</dd>
                    <dt>Ventilation</dt>
                    <dd>{humanize(i.ventilationStrategy)}</dd>
                    {i.requiredCadrM3h !== undefined && (
                      <>
                        <dt>CADR</dt>
                        <dd>{Math.round(i.requiredCadrM3h)} m³/h</dd>
                      </>
                    )}
                  </dl>
                </div>
              ))
            )}
          </div>

          {status.pendingApprovals.length > 0 && (
            <div className="panel">
              <h3 className="panel-title">Awaiting your approval</h3>
              <ul className="list">
                {status.pendingApprovals.map((a) => (
                  <li key={a.id}>{describeCommand(a.command)}</li>
                ))}
              </ul>
            </div>
          )}

          {status.recentDeviceActions.length > 0 && (
            <div className="panel">
              <h3 className="panel-title">Device actions</h3>
              <ul className="list">
                {status.recentDeviceActions.map((a) => (
                  <li key={a.approvalId}>
                    {describeCommand(a.command)} · <strong>{humanize(a.status)}</strong>
                    {a.result?.adapter === "sandbox" ? " (simulated)" : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="card-sub">Device adapter: {status.deviceAdapter ?? "—"}</p>
        </>
      )}
    </aside>
  );
}
