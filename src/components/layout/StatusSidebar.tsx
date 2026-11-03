"use client";

import type { ReactNode } from "react";
import type { StatusReport } from "@/lib/agent/status";
import type { AirQualitySnapshot } from "@/lib/domain";
import { AirQualityCard } from "../cards/AirQualityCard";
import { HealthContextSummary } from "../cards/HealthContextSummary";
import { describeCommand } from "../cards/InterventionPlanCard";
import { fmtTime, humanize } from "../format";

const LEVEL_TONE: Record<string, string | undefined> = { ok: "ok", watch: "watch", act: "act", urgent: "urgent" };

/** One news-sidebar section: heavy top rule + serif heading (focusable target for the rail). */
function NewsSection({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="news-section" aria-labelledby={id}>
      <h2 className="section-head" id={id} tabIndex={-1}>
        <span>{title}</span>
        {aside}
      </h2>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="panel" aria-hidden="true">
      <div className="skeleton" />
      <div className="skeleton" style={{ width: "65%" }} />
    </div>
  );
}

export function StatusSidebar({
  status,
  loading,
  error,
  open,
  monitoring,
  onClose,
  onRecheck,
  rechecking,
}: {
  status: StatusReport | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  monitoring: boolean;
  onClose: () => void;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const c = status?.combined;
  const skeleton = !status && loading;
  return (
    <aside id="status-panel" className="sidebar" data-open={open} aria-label="Health-engineering status" aria-busy={skeleton}>
      <div className="sidebar-head">
        <span className="kicker">
          The status desk<span className="sep" aria-hidden="true" />
          {status?.monitoring?.lastCheckAt ? `Checked ${fmtTime(status.monitoring.lastCheckAt, true)}` : "Updated live"}
        </span>
        <button type="button" className="btn btn-ghost icon-btn sidebar-close" onClick={onClose} aria-label="Close status panel">
          ✕
        </button>
      </div>

      {error && (
        <div className="banner" data-tone="warning" role="status">
          {error}
        </div>
      )}

      {c && (
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
      )}

      <NewsSection
        id="sb-air"
        title="Air now"
        aside={
          monitoring ? (
            <span className="live" data-on="true">
              <span className="dot" aria-hidden="true" />
              Live
            </span>
          ) : undefined
        }
      >
        {skeleton ? (
          <Skeleton />
        ) : status?.airQuality ? (
          <>
            <AirQualityCard snapshot={status.airQuality as AirQualitySnapshot} history={status.airQualityHistory} compact />
            <div className="actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={onRecheck} disabled={rechecking}>
                {rechecking ? "Re-checking…" : "Re-check now"}
              </button>
            </div>
            {status.monitoring?.lastError && <p className="card-sub">Last re-check problem: {status.monitoring.lastError}</p>}
          </>
        ) : (
          <p className="sidebar-empty">Live readings for your location appear here after the first check.</p>
        )}
      </NewsSection>

      <NewsSection id="sb-health" title="Your health context">
        {skeleton ? (
          <Skeleton />
        ) : status?.profileSummary ? (
          <HealthContextSummary profile={status.profileSummary} assessment={status.healthAssessment} compact />
        ) : (
          <p className="sidebar-empty">Anything you share about your health shapes the thresholds. Nothing shared yet.</p>
        )}
      </NewsSection>

      <NewsSection
        id="sb-interventions"
        title="Interventions"
        aside={
          status && status.pendingApprovals.length > 0 ? (
            <span className="badge" data-tone="approval">
              {status.pendingApprovals.length} awaiting you
            </span>
          ) : undefined
        }
      >
        {skeleton ? (
          <Skeleton />
        ) : !status || status.interventions.length === 0 ? (
          <p className="sidebar-empty">No intervention designed yet.</p>
        ) : (
          <ul className="news-list">
            {status.interventions.map((i) => (
              <li key={i.id} className="news-item">
                <span className="card-header">
                  <span className="headline">{i.title}</span>
                  <span className="badge" data-tone={i.status === "active" ? "ok" : "info"}>
                    {humanize(i.status)}
                  </span>
                </span>
                <span className="card-sub">
                  {humanize(i.filterClass)} filter · {humanize(i.ventilationStrategy)}
                  {i.requiredCadrM3h !== undefined ? ` · ${Math.round(i.requiredCadrM3h)} m³/h CADR` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {status && status.pendingApprovals.length > 0 && (
          <div className="panel">
            <h3 className="panel-title">Awaiting your approval</h3>
            <ul className="list">
              {status.pendingApprovals.map((a) => (
                <li key={a.id}>{describeCommand(a.command)}</li>
              ))}
            </ul>
          </div>
        )}
      </NewsSection>

      <NewsSection id="sb-engineering" title="Engineering status">
        {skeleton ? (
          <Skeleton />
        ) : status && c ? (
          <>
            <nav aria-label="Journey">
              <ol className="journey">
                {c.steps.map((s) => (
                  <li key={s.key} data-done={s.done}>
                    <span className="dot" aria-hidden="true">
                      {s.done ? "✓" : ""}
                    </span>
                    <span>
                      {s.label}
                      <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
                      {s.detail && (
                        <span className="detail">
                          {s.key === "monitoring" && status.monitoring?.lastCheckAt
                            ? `Last check ${fmtTime(status.monitoring.lastCheckAt, true)}`
                            : s.detail}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </nav>
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
        ) : (
          <p className="sidebar-empty">
            Assess → design → approve → monitor. Progress through each step is tracked here once a briefing starts.
          </p>
        )}
      </NewsSection>
    </aside>
  );
}
