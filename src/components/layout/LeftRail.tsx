"use client";

import type { ReactNode } from "react";

export type RailSection = "chat" | "status" | "interventions" | "how";

const ICONS: Record<RailSection, ReactNode> = {
  chat: <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />,
  status: (
    <>
      <path d="M3 12h4l2-5 4 10 2-5h6" />
    </>
  ),
  interventions: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  how: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
};

const ITEMS: Array<{ id: RailSection; label: string; controls?: string }> = [
  { id: "chat", label: "Briefing" },
  { id: "status", label: "Status", controls: "status-panel" },
  { id: "interventions", label: "Plans", controls: "status-panel" },
  { id: "how", label: "Guide" },
];

/** Editor-style tool rail (bottom tab bar on phones). */
export function LeftRail({
  active,
  onSelect,
  pendingCount,
}: {
  active: RailSection;
  onSelect: (s: RailSection) => void;
  pendingCount: number;
}) {
  return (
    <nav className="rail" aria-label="Workspace">
      <ul>
        {ITEMS.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              className="rail-btn"
              aria-current={active === it.id ? "true" : undefined}
              aria-controls={it.controls}
              aria-haspopup={it.id === "how" ? "dialog" : undefined}
              onClick={() => onSelect(it.id)}
            >
              <span className="rail-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  {ICONS[it.id]}
                </svg>
              </span>
              <span>{it.label}</span>
              {it.id === "interventions" && pendingCount > 0 && (
                <span className="rail-count">
                  {pendingCount}
                  <span className="sr-only"> pending approval{pendingCount === 1 ? "" : "s"}</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
