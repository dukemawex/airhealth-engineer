"use client";

import ReactMarkdown from "react-markdown";
import type { AgentUIMessage, ApprovalView, NoticeData } from "@/lib/ui-types";
import { ApprovalRequestCard } from "../cards/ApprovalRequestCard";
import { ToolResultCard, type ToolPartView } from "../cards/ToolResultCard";

export function NoticeCard({ notice, onRetry, busy }: { notice: NoticeData; onRetry?: () => void; busy?: boolean }) {
  return (
    <div className="banner" data-tone={notice.level === "info" ? "info" : notice.level === "warning" ? "warning" : "error"} role="status">
      <span>{notice.message}</span>
      {notice.retryable && onRetry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry} disabled={busy}>
          Retry
        </button>
      )}
    </div>
  );
}

export function MessageBubble({
  message,
  history,
  busy,
  onReviewApproval,
  onRetry,
}: {
  message: AgentUIMessage;
  history: Array<{ at: string; pm25?: number }>;
  busy: boolean;
  onReviewApproval: (a: ApprovalView) => void;
  onRetry: () => void;
}) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <article className="msg msg-user" aria-label="You said">
        <div className="bubble">{text}</div>
      </article>
    );
  }
  return (
    <article className="msg msg-assistant" aria-label="AirHealth Engineer replied">
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        if (part.type === "text") {
          if (!part.text.trim()) return null;
          const monitor = part.text.startsWith("**Monitoring update**");
          return (
            <div key={key} className={`bubble md${monitor ? " monitor" : ""}`}>
              <ReactMarkdown>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (part.type === "dynamic-tool") {
          return <ToolResultCard key={key} part={part as unknown as ToolPartView} history={history} />;
        }
        if (part.type === "data-approval") {
          return <ApprovalRequestCard key={key} approval={part.data} onReview={onReviewApproval} busy={busy} />;
        }
        if (part.type === "data-notice") {
          return <NoticeCard key={key} notice={part.data} onRetry={onRetry} busy={busy} />;
        }
        return null;
      })}
    </article>
  );
}
