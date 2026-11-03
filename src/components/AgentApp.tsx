"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatusReport } from "@/lib/agent/status";
import type { LocationQuery } from "@/lib/domain";
import { ApiError, apiFetch, authHeaders, conversationStore, fetchJsonLoose, tokenStore } from "@/lib/client/api";
import type { AgentUIMessage, ApprovalView } from "@/lib/ui-types";
import { ApprovalModal } from "./cards/ApprovalModal";
import { Composer } from "./chat/Composer";
import { MessageBubble } from "./chat/MessageBubble";
import { AccessDialog } from "./layout/AccessDialog";
import { Header } from "./layout/Header";
import { HowItWorksDialog } from "./layout/HowItWorksDialog";
import { StatusSidebar } from "./layout/StatusSidebar";
import { EmptyState } from "./states/EmptyState";
import { LoadingState, SuccessToast } from "./states/States";

const STATUS_POLL_MS = 30_000;
const MONITOR_POLL_MS = 5 * 60_000;

type SendBody =
  | { approval: { id: string; decision: "approve" | "reject"; note?: string } }
  | { resume: true }
  | { location?: LocationQuery };

type HealthResponse = { status?: string; checks?: { metaModelApi?: { configured?: boolean; model?: string } } };
type MonitorResponse = { checked: boolean; notified?: boolean; reason?: string };

/** Extract a readable message from an AI SDK transport error (body is our JSON error envelope). */
function errorText(err: Error | undefined): { message: string; unauthorized: boolean } {
  if (!err) return { message: "", unauthorized: false };
  try {
    const parsed = JSON.parse(err.message) as { error?: { message?: string; code?: string } };
    return { message: parsed.error?.message ?? err.message, unauthorized: parsed.error?.code === "unauthorized" };
  } catch {
    return { message: err.message || "Request failed", unauthorized: /unauthori[sz]ed/i.test(err.message) };
  }
}

function latestApprovals(messages: AgentUIMessage[]): ApprovalView[] {
  const byId = new Map<string, ApprovalView>();
  for (const m of messages) for (const p of m.parts) if (p.type === "data-approval") byId.set(p.data.id, p.data);
  return [...byId.values()];
}

/**
 * useChat transport: user turns go to /api/agent; approval decisions go to the
 * approval endpoints (?stream=ui) so the resumed run streams into the same chat.
 */
function createConnection() {
  let conversationId: string | null = null;
  const getConversationId = () => conversationId;
  const transport = new DefaultChatTransport<AgentUIMessage>({
    api: "/api/agent",
    prepareSendMessagesRequest: ({ messages, body }) => {
      const b = (body ?? {}) as SendBody;
      const headers = authHeaders();
      if ("approval" in b) {
        const { id, decision, note } = b.approval;
        return {
          api: `/api/approvals/${encodeURIComponent(id)}/${decision}?stream=ui`,
          body: decision === "approve" ? { decidedBy: "web-ui", note } : { decidedBy: "web-ui", reason: note },
          headers,
        };
      }
      if ("resume" in b) return { body: { conversationId: getConversationId(), resume: true }, headers };
      const last = messages[messages.length - 1];
      const text = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
      return {
        body: { conversationId: getConversationId() ?? undefined, message: text, location: "location" in b ? b.location : undefined },
        headers,
      };
    },
  });
  return {
    transport,
    getId: getConversationId,
    setId: (id: string | null) => {
      conversationId = id;
    },
  };
}

export function AgentApp() {
  const [conn] = useState(createConnection);
  const [conversationId, setConversationIdState] = useState<string | null>(null);
  const setConversationId = useCallback((id: string | null) => {
    conn.setId(id);
    setConversationIdState(id);
    if (id) conversationStore.set(id);
    else conversationStore.clear();
  }, [conn]);

  const [restoring, setRestoring] = useState(true);
  const [status, setStatus] = useState<StatusReport | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null);
  const [agentDetail, setAgentDetail] = useState("Checking configuration");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Mobile drawer: Escape closes it.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);
  const [howOpen, setHowOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [reviewing, setReviewing] = useState<ApprovalView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const autoShown = useRef(new Set<string>());
  const lastDecision = useRef<"approve" | "reject" | null>(null);


  const refreshStatus = useCallback(async (id = conn.getId()) => {
    if (!id) return;
    setStatusLoading(true);
    try {
      const s = await apiFetch<StatusReport>(`/api/sessions/${encodeURIComponent(id)}/status`);
      setStatus(s);
      setStatusError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAccessOpen(true);
      setStatusError(err instanceof Error ? `Status unavailable: ${err.message}` : "Status unavailable");
    } finally {
      setStatusLoading(false);
    }
  }, [conn]);

  const chat = useChat<AgentUIMessage>({
    transport: conn.transport,
    throttle: 40,
    onData: (part) => {
      if (part.type === "data-conversation" && part.data.id !== conn.getId()) setConversationId(part.data.id);
    },
    onFinish: () => {
      void refreshStatus();
      if (lastDecision.current) {
        setToast(lastDecision.current === "approve" ? "Approved. Device action processed and status updated." : "Rejected. Nothing was executed.");
        lastDecision.current = null;
      }
    },
    onError: (err) => {
      const { message, unauthorized } = errorText(err);
      if (unauthorized) setAccessOpen(true);
      setBanner(message);
      lastDecision.current = null;
      void refreshStatus();
    },
  });
  const { messages, setMessages, sendMessage, status: chatStatus, stop } = chat;
  const busy = chatStatus === "submitted" || chatStatus === "streaming";

  const loadConversation = useCallback(
    async (id: string) => {
      const data = await apiFetch<{ messages: AgentUIMessage[]; status: StatusReport }>(`/api/agent?conversationId=${encodeURIComponent(id)}`);
      setMessages(data.messages);
      setStatus(data.status);
    },
    [setMessages],
  );

  // Restore the last conversation on this device (server is the source of truth).
  useEffect(() => {
    const restore = async () => {
      const saved = conversationStore.get();
      if (!saved) return;
      conn.setId(saved);
      setConversationIdState(saved);
      await loadConversation(saved);
    };
    restore()
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setConversationId(null);
        else if (err instanceof ApiError && err.status === 401) setAccessOpen(true);
        else setBanner(err instanceof Error ? `Couldn't restore your conversation: ${err.message}` : "Couldn't restore your conversation");
      })
      .finally(() => setRestoring(false));
  }, [conn, loadConversation, setConversationId]);

  // Agent online indicator: Meta Model API key configured on the server.
  useEffect(() => {
    void fetchJsonLoose<HealthResponse>("/api/health").then(({ status: code, data }) => {
      const configured = Boolean(data?.checks?.metaModelApi?.configured);
      setAgentOnline(code !== 0 && configured);
      setAgentDetail(
        code === 0
          ? "Server unreachable"
          : configured
            ? `Muse Spark (${data?.checks?.metaModelApi?.model ?? "configured"}) via the Meta Model API`
            : "Meta Model API key not configured on the server",
      );
    });
  }, []);

  // Live status poll + monitoring re-check poll.
  useEffect(() => {
    if (!conversationId) return;
    const visible = () => document.visibilityState === "visible";
    const statusTimer = setInterval(() => visible() && void refreshStatus(), STATUS_POLL_MS);
    const monitor = async () => {
      const id = conn.getId();
      if (!visible() || !id) return;
      try {
        const r = await apiFetch<MonitorResponse>(`/api/sessions/${encodeURIComponent(id)}/monitor`, {
          method: "POST",
          body: "{}",
        });
        if (r.checked) {
          await refreshStatus();
          if (r.notified && chat.status === "ready") await loadConversation(id);
        }
      } catch {
        /* surfaced through status.monitoring.lastError */
      }
    };
    const monitorTimer = setInterval(monitor, MONITOR_POLL_MS);
    return () => {
      clearInterval(statusTimer);
      clearInterval(monitorTimer);
    };
  }, [conn, conversationId, refreshStatus, loadConversation, chat.status]);

  const approvals = useMemo(() => latestApprovals(messages), [messages]);
  const pending = approvals.filter((a) => a.status === "pending");

  // Open the approval modal once per new request, after the stream settles.
  useEffect(() => {
    if (busy || reviewing) return;
    const next = pending.find((a) => !autoShown.current.has(a.id));
    if (next) {
      autoShown.current.add(next.id);
      setReviewing(next);
    }
  }, [busy, pending, reviewing]);

  // Keep the newest content in view unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = (text: string, location?: LocationQuery) => {
    setBanner(null);
    void sendMessage({ text }, { body: { location } satisfies SendBody });
  };
  const decide = (a: ApprovalView, decision: "approve" | "reject", note?: string) => {
    setReviewing(null);
    setBanner(null);
    lastDecision.current = decision;
    void sendMessage(undefined, { body: { approval: { id: a.id, decision, note } } satisfies SendBody });
  };
  const retry = () => {
    if (!conn.getId()) return;
    setBanner(null);
    void sendMessage(undefined, { body: { resume: true } satisfies SendBody });
  };
  const recheck = async () => {
    const id = conn.getId();
    if (!id) return;
    setRechecking(true);
    try {
      const r = await apiFetch<MonitorResponse>(`/api/sessions/${encodeURIComponent(id)}/monitor`, {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
      await refreshStatus();
      if (r.notified) await loadConversation(id);
      setToast(r.checked ? "Air quality re-checked." : `Re-check skipped (${r.reason?.replaceAll("_", " ") ?? "unavailable"}).`);
    } catch (err) {
      setBanner(err instanceof Error ? `Re-check failed: ${err.message}` : "Re-check failed");
    } finally {
      setRechecking(false);
    }
  };
  const newConversation = () => {
    stop();
    setConversationId(null);
    setMessages([]);
    setStatus(null);
    setBanner(null);
    autoShown.current.clear();
  };

  const history = status?.airQualityHistory ?? [];
  const monitoringOn = Boolean(status?.monitoring?.enabled && status.location);
  const lastIsUser = messages.at(-1)?.role === "user";

  return (
    <div className="app">
      <a href="#composer-input" className="skip-link">
        Skip to message box
      </a>
      <Header
        agentOnline={agentOnline}
        agentDetail={agentDetail}
        monitoring={monitoringOn}
        monitoringDetail={
          monitoringOn
            ? `Re-checking air quality for this conversation${status?.monitoring?.lastCheckAt ? `; last check ${new Date(status.monitoring.lastCheckAt).toLocaleTimeString()}` : ""}`
            : "Monitoring starts once a location is known"
        }
        onHowItWorks={() => setHowOpen(true)}
        onNew={newConversation}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        sidebarOpen={sidebarOpen}
        hasConversation={Boolean(conversationId || messages.length)}
      />
      <div className="main">
        <main className="chat" id="main">
          <div
            className="chat-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}
          >
            <div className="chat-inner" role="log" aria-live="polite" aria-busy={busy} aria-label="Conversation">
              {restoring ? (
                <LoadingState label="Restoring your conversation" />
              ) : messages.length === 0 ? (
                <EmptyState disabled={busy} onStart={({ message, location }) => send(message, location)} />
              ) : (
                messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    history={history}
                    busy={busy}
                    onReviewApproval={setReviewing}
                    onRetry={retry}
                  />
                ))
              )}
              {chatStatus === "submitted" && <LoadingState />}
              {banner && (
                <div className="banner" data-tone="error" role="alert">
                  <span>{banner}</span>
                  {conversationId && lastIsUser && !busy && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
                      Retry
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <Composer
            disabled={busy || pending.length > 0 || restoring}
            busy={busy}
            onSend={(t) => send(t)}
            onStop={stop}
            disabledReason={pending.length > 0 ? "Approve or reject the pending device action to continue." : undefined}
          />
        </main>
        <div className="backdrop" data-open={sidebarOpen} onClick={() => setSidebarOpen(false)} aria-hidden="true" />
        <StatusSidebar
          status={status}
          loading={statusLoading}
          error={statusError}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onRecheck={recheck}
          rechecking={rechecking}
        />
      </div>
      <ApprovalModal approval={reviewing} adapter={status?.deviceAdapter} onClose={() => setReviewing(null)} onDecide={decide} />
      <HowItWorksDialog open={howOpen} onClose={() => setHowOpen(false)} />
      <AccessDialog
        open={accessOpen}
        onClose={() => setAccessOpen(false)}
        onSave={(t) => {
          tokenStore.set(t);
          setAccessOpen(false);
          setBanner(null);
          const id = conn.getId();
          if (id) void loadConversation(id).catch(() => undefined);
        }}
      />
      <SuccessToast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
