"use client";

import ReactMarkdown from "react-markdown";
import type { AgentUIMessage, ApprovalView, NoticeData } from "@/lib/ui-types";
import { ApprovalRequestCard } from "../cards/ApprovalRequestCard";
import { ToolResultCard, type ToolPartView } from "../cards/ToolResultCard";
import { SceneCard } from "../cards/SceneCard";
import { ReasoningTimeline } from "../judge/ReasoningTimeline";

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
  judge = false,
  onSendText,
}: {
  judge?: boolean;
  onSendText?: (text: string) => void;
  message: AgentUIMessage;
  history: Array<{ at: string; pm25?: number }>;
  busy: boolean;
  onReviewApproval: (a: ApprovalView) => void;
  onRetry: () => void;
}) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <article className="msg msg-user" aria-label="You said" data-msg-id={message.id}>
        <span className="msg-label" aria-hidden="true">
          You
        </span>
        <div className="bubble">{text}</div>
        {message.metadata?.scene && (
          <SceneCard imageUrl={message.metadata.scene.imageUrl} result={message.metadata.scene.result} judge={judge} />
        )}
      </article>
    );
  }
  const traces = message.parts.flatMap((p) => (p.type === "data-trace" ? [p.data] : []));
  return (
    <article className="msg msg-assistant" aria-label="AirHealth Engineer replied">
      <div className="byline" aria-hidden="true">
        <strong>AirHealth desk</strong>
        <span>· Muse Spark</span>
      </div>
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
          return <ToolResultCard key={key} part={part as unknown as ToolPartView} history={history} onApplyStep={onSendText} busy={busy} />;
        }
        if (part.type === "data-approval") {
          return <ApprovalRequestCard key={key} approval={part.data} onReview={onReviewApproval} busy={busy} />;
        }
        if (part.type === "data-notice") {
          return <NoticeCard key={key} notice={part.data} onRetry={onRetry} busy={busy} />;
        }
        return null;
      })}
      <ReasoningTimeline traces={traces} judge={judge} />
    </article>
  );
}
