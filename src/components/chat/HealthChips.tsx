"use client";

import { useId } from "react";
import { HEALTH_CHIPS, isChipActive, type HealthChip } from "@/lib/healthChips";

const GROUPS: Array<{ kind: HealthChip["kind"]; title: string }> = [
  { kind: "about", title: "About you or your home" },
  { kind: "symptom", title: "How you feel today" },
];

/** Tap-to-toggle suggestions; pressed state is derived from the text so typing and tapping stay in sync. */
export function HealthChips({
  text,
  onToggle,
  compact = false,
  disabled = false,
}: {
  text: string;
  onToggle: (chip: HealthChip) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="health-chips" data-compact={compact || undefined}>
      {GROUPS.map((g) => (
        <div key={g.kind} className="chip-group" role="group" aria-labelledby={`${id}-${g.kind}`}>
          <span id={`${id}-${g.kind}`} className={compact ? "sr-only" : "chip-group-title"}>
            {g.title}
          </span>
          <ul className="chip-list">
            {HEALTH_CHIPS.filter((c) => c.kind === g.kind).map((c) => {
              const on = isChipActive(text, c);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className="chip"
                    data-kind={c.kind}
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => onToggle(c)}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                      {on ? <path d="m5 12 5 5 9-10" /> : <path d="M12 5v14M5 12h14" />}
                    </svg>
                    {c.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
