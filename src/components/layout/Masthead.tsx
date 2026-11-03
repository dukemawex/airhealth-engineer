"use client";

import { useToday } from "@/lib/client/useToday";
import { Logo } from "../brand/Logo";

function LiveBadge({ on, label, short, detail }: { on: boolean | "checking"; label: string; short?: string; detail: string }) {
  return (
    <span className="live" data-on={String(on)} title={detail}>
      <span className="dot" aria-hidden="true" />
      {short ? (
        <>
          <span className="live-text-long" aria-hidden="true">
            {label}
          </span>
          <span aria-hidden="true" className="live-text-short">
            {short}
          </span>
        </>
      ) : (
        <span aria-hidden="true">{label}</span>
      )}
      <span className="sr-only">{detail}</span>
    </span>
  );
}

/** Editorial masthead: dateline strip with live badges, then the wordmark and pill actions. */
export function Masthead({
  agentOnline,
  agentDetail,
  monitoring,
  monitoringDetail,
  onHowItWorks,
  onNew,
  hasConversation,
  judge,
  onToggleJudge,
}: {
  judge?: boolean;
  onToggleJudge?: () => void;
  agentOnline: boolean | null;
  agentDetail: string;
  monitoring: boolean;
  monitoringDetail: string;
  onHowItWorks: () => void;
  onNew: () => void;
  hasConversation: boolean;
}) {
  const today = useToday();
  return (
    <header className="masthead">
      <div className="masthead-strip">
        <span className="dateline" suppressHydrationWarning>
          {today || "\u00a0"}
        </span>
        <span className="strip-sep" aria-hidden="true" />
        <span className="strip-note">Live air-health briefing · reasoning by Muse Spark · every device action approved by you</span>
        <div className="live-badges" aria-label="System status" role="group">
          <LiveBadge
            on={agentOnline === null ? "checking" : agentOnline}
            label={agentOnline ? "Agent online" : agentOnline === false ? "Agent offline" : "Checking"}
            short={agentOnline ? "Agent" : agentOnline === false ? "Offline" : "…"}
            detail={agentDetail}
          />
          <LiveBadge
            on={monitoring}
            label={monitoring ? "Live · Monitoring" : "Monitoring off"}
            short={monitoring ? "Live" : "Off"}
            detail={monitoringDetail}
          />
        </div>
      </div>
      <div className="masthead-main">
        <p className="masthead-tag">Cleaner air, engineered for you.</p>
        <div className="wordmark">
          <Logo size={40} />
          <span className="wordmark-text">
            AirHealth <em>Engineer</em>
          </span>
        </div>
        <div className="masthead-actions">
          {onToggleJudge && (
            <button
              type="button"
              className="btn btn-secondary judge-toggle"
              onClick={onToggleJudge}
              aria-pressed={Boolean(judge)}
              aria-label="Judge mode"
              title="Judge mode: show live reasoning telemetry and which Meta endpoints are live"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12h4l3-8 4 16 3-8h4" />
              </svg>
              <span className="btn-label">Judge mode</span>
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onHowItWorks} aria-haspopup="dialog" aria-label="How it works">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8h.01" />
            </svg>
            <span className="btn-label" aria-hidden="true">
              How it works
            </span>
          </button>
          {hasConversation && (
            <button type="button" className="btn btn-primary" onClick={onNew} aria-label="Start a new briefing">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="btn-label" aria-hidden="true">
                New briefing
              </span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
