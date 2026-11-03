"use client";

import type { ApprovalView } from "@/lib/ui-types";
import { fmtTime, humanize } from "../format";
import { describeCommand } from "./InterventionPlanCard";

const TONE: Record<string, string | undefined> = {
  pending: "approval",
  executed: "ok",
  approved: "ok",
  rejected: undefined,
  expired: "watch",
  failed: "act",
};

export function ApprovalRequestCard({
  approval,
  onReview,
  busy,
}: {
  approval: ApprovalView;
  onReview: (a: ApprovalView) => void;
  busy: boolean;
}) {
  const pending = approval.status === "pending";
  return (
    <section className="card" data-tone={pending ? "approval" : undefined} aria-label="Device action approval">
      <div className="card-header">
        <div className="card-title">
          <ShieldIcon />
          {pending ? "Approval needed" : "Device action decision"}
        </div>
        <span className="badge" data-tone={TONE[approval.status]}>
          {humanize(approval.status)}
        </span>
      </div>
      <div className="command">{describeCommand(approval.command)}</div>
      <p style={{ fontSize: "var(--text-sm)" }}>{approval.reason}</p>
      {pending ? (
        <div className="actions">
          <button type="button" className="btn btn-approve" onClick={() => onReview(approval)} disabled={busy}>
            Review &amp; decide
          </button>
          <span className="card-sub">Nothing runs until you approve. Expires {fmtTime(approval.expiresAt)}.</span>
        </div>
      ) : (
        <p className="card-sub">
          {approval.decidedAt ? `Decided ${fmtTime(approval.decidedAt, true)}` : ""}
          {approval.decisionNote ? ` · “${approval.decisionNote}”` : ""}
          {approval.result ? ` · ${approval.result.message}` : ""}
        </p>
      )}
    </section>
  );
}

export function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--color-approval)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
