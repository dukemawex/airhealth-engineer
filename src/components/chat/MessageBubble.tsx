"use client";

import ReactMarkdown from "react-markdown";
import type { AgentUIMessage, ApprovalView, NoticeData } from "@/lib/ui-types";
import { ApprovalRequestCard } from "../cards/ApprovalRequestCard";
import { isLocationRequestPart, ToolResultCard, type ToolPartView } from "../cards/ToolResultCard";
import { LocationRequestCard } from "../location/LocationRequestCard";
import { useLocationActions } from "../location/LocationContext";
import { SceneCard } from "../cards/SceneCard";
import { ReasoningTimeline } from "../judge/ReasoningTimeline";
import { cleanReplyBlocks } from "@/lib/agent/replyCopy";

/** The reply asks the user for a place in text (no card was emitted): offer the card anyway. */
const ASKS_FOR_PLACE =
  /\b(?:share|send|tell me|give me|what(?:'s| is)|which|need|type)\b[^.?!\n]{0,40}\b(?:location|city|town|area|postcode|coordinates|where you are)\b|\bwhere are you\b/i;

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
  profileAskedBefore = false,
  isLast = false,
}: {
  isLast?: boolean;
  profileAskedBefore?: boolean;
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
  return <AssistantBubble {...{ message, history, busy, onReviewApproval, onRetry, judge, onSendText, profileAskedBefore, isLast }} />;
}

function AssistantBubble({
  message,
  history,
  busy,
  onReviewApproval,
  onRetry,
  judge,
  onSendText,
  profileAskedBefore,
  isLast,
}: {
  message: AgentUIMessage;
  history: Array<{ at: string; pm25?: number }>;
  busy: boolean;
  onReviewApproval: (a: ApprovalView) => void;
  onRetry: () => void;
  judge: boolean;
  onSendText?: (text: string) => void;
  profileAskedBefore: boolean;
  isLast: boolean;
}) {
  const loc = useLocationActions();
  const traces = message.parts.flatMap((p) => (p.type === "data-trace" ? [p.data] : []));
  // One sensitivity-profile question per reply (Muse Spark may repeat it in each step).
  const textIdx = message.parts.flatMap((p, i) => (p.type === "text" && !p.text.startsWith("**Monitoring update**") ? [i] : []));
  const cleaned = cleanReplyBlocks(
    textIdx.map((i) => {
      const p = message.parts[i];
      return p?.type === "text" ? p.text : "";
    }),
    { alreadyAsked: profileAskedBefore },
  );
  const textFor = new Map(textIdx.map((i, k) => [i, cleaned[k] ?? ""]));
  // One Share-my-location card per reply (requestLocation and a needsLocation result may both fire).
  const firstLocCard = message.parts.findIndex((p) => p.type === "dynamic-tool" && isLocationRequestPart(p as unknown as ToolPartView));
  const fallbackLocCard =
    firstLocCard < 0 && isLast && !busy && Boolean(loc && !loc.known) && cleaned.some((t) => ASKS_FOR_PLACE.test(t));
  return (
    <article className="msg msg-assistant" aria-label="AirHealth Engineer replied">
      <div className="byline" aria-hidden="true">
        <strong>AirHealth desk</strong>
        <span>· Muse Spark</span>
      </div>
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        if (part.type === "text") {
          const text = textFor.get(i) ?? part.text;
          if (!text.trim()) return null;
          const monitor = part.text.startsWith("**Monitoring update**");
          return (
            <div key={key} className={`bubble md${monitor ? " monitor" : ""}`}>
              <ReactMarkdown>{text}</ReactMarkdown>
            </div>
          );
        }
        if (part.type === "dynamic-tool") {
          if (i !== firstLocCard && isLocationRequestPart(part as unknown as ToolPartView)) return null;
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
      {fallbackLocCard && <LocationRequestCard />}
      <ReasoningTimeline traces={traces} judge={judge} />
    </article>
  );
}
