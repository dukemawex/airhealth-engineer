"use client";

import { Logo } from "../brand/Logo";

export function Header({
  agentOnline,
  agentDetail,
  monitoring,
  monitoringDetail,
  onHowItWorks,
  onNew,
  onToggleSidebar,
  sidebarOpen,
  hasConversation,
}: {
  agentOnline: boolean | null;
  agentDetail: string;
  monitoring: boolean;
  monitoringDetail: string;
  onHowItWorks: () => void;
  onNew: () => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  hasConversation: boolean;
}) {
  return (
    <header className="header">
      <div className="brand">
        <Logo size={30} />
        <span className="brand-name">AirHealth Engineer</span>
      </div>
      <div className="indicators" aria-label="System status">
        <span className="indicator" title={agentDetail}>
          <span className="pulse" data-state={agentOnline ? "on" : agentOnline === false ? "warn" : undefined} aria-hidden="true" />
          <span className="indicator-label">{agentOnline ? "Agent online" : agentOnline === false ? "Agent offline" : "Checking…"}</span>
          <span className="sr-only">{agentDetail}</span>
        </span>
        <span className="indicator" title={monitoringDetail}>
          <span className="pulse" data-state={monitoring ? "on" : undefined} aria-hidden="true" />
          <span className="indicator-label">{monitoring ? "Monitoring" : "Not monitoring"}</span>
          <span className="sr-only">{monitoringDetail}</span>
        </span>
      </div>
      <div className="spacer" />
      <button type="button" className="btn btn-ghost" onClick={onHowItWorks} aria-label="How it works" aria-haspopup="dialog">
        <span aria-hidden="true">ⓘ</span>
        <span className="how-label" aria-hidden="true">
          How it works
        </span>
      </button>
      {hasConversation && (
        <button type="button" className="btn btn-ghost" onClick={onNew} aria-label="Start a new conversation">
          New
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost icon-btn sidebar-toggle"
        onClick={onToggleSidebar}
        aria-expanded={sidebarOpen}
        aria-controls="status-panel"
        aria-label="Show status panel"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      </button>
    </header>
  );
}
