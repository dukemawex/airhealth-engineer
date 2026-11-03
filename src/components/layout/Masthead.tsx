"use client";

import { useTheme } from "@/lib/client/theme";
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

/** Studio top bar: logo + wordmark, live badges, and pill actions (theme, judge, guide, new). */
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
  const { theme, toggle } = useTheme();
  return (
    <header className="masthead">
      <div className="masthead-main">
        <div className="wordmark">
          <Logo size={34} />
          <span className="wordmark-text">
            AirHealth <em>Engineer</em>
          </span>
          <span className="studio-tag" aria-hidden="true">
            Studio
          </span>
        </div>
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
        <div className="masthead-actions">
          <button
            type="button"
            className="btn btn-secondary icon-btn theme-toggle"
            onClick={toggle}
            aria-pressed={theme === "light"}
            aria-label="Light mode"
            title={theme === "light" ? "Switch to the dark studio" : "Switch to light mode"}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {theme === "light" ? (
                <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
              ) : (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </>
              )}
            </svg>
          </button>
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
