"use client";

import { useEffect, useRef, useState } from "react";
import type { ApprovalView } from "@/lib/ui-types";
import { fmtTime, humanize } from "../format";
import { ShieldIcon } from "./ApprovalRequestCard";
import { describeCommand } from "./InterventionPlanCard";

/**
 * Human approval gate. Uses the native <dialog> (focus trap, Escape to close,
 * inert background). Approve/Reject call the approval endpoints via onDecide.
 */
export function ApprovalModal({
  approval,
  adapter,
  onClose,
  onDecide,
}: {
  approval: ApprovalView | null;
  adapter?: string | null;
  onClose: () => void;
  onDecide: (a: ApprovalView, decision: "approve" | "reject", note?: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (approval && !d.open) {
      setNote("");
      d.showModal();
    } else if (!approval && d.open) d.close();
  }, [approval]);

  const c = approval?.command;
  return (
    <dialog ref={ref} className="modal" aria-labelledby="approval-title" aria-describedby="approval-desc" onClose={onClose}>
      {approval && c && (
        <div className="modal-body">
          <div className="modal-header">
            <div>
              <span className="kicker">Human approval gate</span>
              <h2 id="approval-title" className="card-title">
                <ShieldIcon /> Approve device action?
              </h2>
              <p id="approval-desc" className="card-sub">
                Muse Spark proposed this action. It will only run if you approve it.
                {adapter === "sandbox" ? " Sandbox mode: the action is simulated and no physical device changes." : ""}
              </p>
            </div>
            <button type="button" className="btn btn-ghost icon-btn" onClick={onClose} aria-label="Close without deciding">
              ✕
            </button>
          </div>
          <dl className="kv">
            <dt>Device</dt>
            <dd>
              {humanize(c.deviceType)} · <code>{c.deviceId}</code>
            </dd>
            <dt>Action</dt>
            <dd>{describeCommand(c).split(": ").slice(1).join(": ")}</dd>
            <dt>Why</dt>
            <dd>{approval.reason}</dd>
            <dt>Expires</dt>
            <dd>{fmtTime(approval.expiresAt, true)}</dd>
          </dl>
          <div className="field">
            <label htmlFor="approval-note">Note (optional)</label>
            <textarea
              id="approval-note"
              className="textarea"
              rows={2}
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
              aria-describedby="approval-note-hint"
            />
            <span id="approval-note-hint" className="hint">
              Saved with the decision. For a rejection, this is passed to the agent as the reason.
            </span>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-reject" onClick={() => onDecide(approval, "reject", note.trim() || undefined)}>
              Reject
            </button>
            <button type="button" className="btn btn-approve" autoFocus onClick={() => onDecide(approval, "approve", note.trim() || undefined)}>
              Approve &amp; run
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
