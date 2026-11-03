"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatusReport } from "@/lib/agent/status";
import type { HealthProfile, LocationQuery, SessionScene } from "@/lib/domain";
import type { SceneAnalysis, VisionResult } from "@/lib/vision/scene";
import { liveChangeMessage, sceneChanges } from "@/lib/liveScene";
import type { LiveFrameResult } from "./camera/CameraSheet";
import { prepareMedia } from "@/lib/client/media";
import { SceneProgress } from "./cards/SceneCard";
import { ApiError, apiFetch, authHeaders, conversationStore, fetchJsonLoose, tokenStore } from "@/lib/client/api";
import { getSpeakPreference, speak, stopSpeaking } from "@/lib/client/speech";
import type { AgentUIMessage, ApprovalView } from "@/lib/ui-types";
import { ApprovalModal } from "./cards/ApprovalModal";
import { Composer } from "./chat/Composer";
import { MessageBubble } from "./chat/MessageBubble";
import { asksForProfile, dedupeProfileAsks } from "@/lib/agent/profileAsk";
import { JudgePanel } from "./judge/JudgePanel";
import { StudioGallery, type GalleryScene } from "./studio/StudioGallery";
import { useJudgeMode } from "@/lib/client/judge";
import { totalTraces } from "@/lib/traceStats";
import { AccessDialog } from "./layout/AccessDialog";
import { LeftRail, type RailSection } from "./layout/LeftRail";
import { Masthead } from "./layout/Masthead";
import { HowItWorksDialog } from "./layout/HowItWorksDialog";
import { NewsSection, StatusSidebar } from "./layout/StatusSidebar";
import { BluetoothPanel } from "./devices/BluetoothPanel";
import { SmartPlugPanel } from "./devices/SmartPlugPanel";
import { NewsPanel } from "./news/NewsPanel";
import { describeCommand } from "./cards/InterventionPlanCard";
import { bridgeReady, sendApprovedCommand } from "@/lib/client/bluetooth";
import { EmptyState } from "./states/EmptyState";
import { GeoFailure, getCurrentFix, type GeoFailureKind } from "@/lib/client/geolocation";
import { shouldLocateBeforeSend } from "@/lib/client/locationIntent";
import { LocationActionsContext, type LocationActions } from "./location/LocationContext";
import { LoadingState, SuccessToast } from "./states/States";

const STATUS_POLL_MS = 30_000;
const MONITOR_POLL_MS = 5 * 60_000;

type SendBody =
  | { approval: { id: string; decision: "approve" | "reject"; note?: string } }
  | { resume: true }
  | { location?: LocationQuery; profile?: HealthProfile; scene?: SessionScene };

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
        body: {
          conversationId: getConversationId() ?? undefined,
          message: text,
          location: "location" in b ? b.location : undefined,
          profile: "profile" in b ? b.profile : undefined,
          scene: "scene" in b ? b.scene : undefined,
        },
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
  const [railSection, setRailSection] = useState<RailSection>("chat");
  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    setRailSection("chat");
  }, []);

  // Drawer (tablet/phone): Escape closes it.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen, closeSidebar]);
  const [howOpen, setHowOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [reviewing, setReviewing] = useState<ApprovalView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const autoShown = useRef(new Set<string>());
  const lastDecision = useRef<"approve" | "reject" | null>(null);
  /** Approved command waiting to be forwarded to a connected Bluetooth bridge once the server confirms. */
  const pendingBle = useRef<ApprovalView | null>(null);


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
    onFinish: ({ message, isAbort, isError }) => {
      void refreshStatus();
      // Spoken replies: only when the user turned them on, and only the final assistant text.
      if (!isAbort && !isError && message.role === "assistant" && getSpeakPreference()) {
        const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
        if (text) speak(text);
      }
      if (lastDecision.current) {
        setToast(lastDecision.current === "approve" ? "Approved. Device action processed and status updated." : "Rejected. Nothing was executed.");
        lastDecision.current = null;
      }
      // Forward to Bluetooth only after the server accepted the approval (stream finished cleanly).
      const ble = pendingBle.current;
      pendingBle.current = null;
      if (ble && !isAbort && !isError && bridgeReady()) {
        void sendApprovedCommand(ble.id, ble.command, describeCommand(ble.command)).then((ok) =>
          setToast(ok ? "Approved command sent to your Bluetooth device." : "Approved, but the Bluetooth device didn't accept the command."),
        );
      }
    },
    onError: (err) => {
      const { message, unauthorized } = errorText(err);
      if (unauthorized) setAccessOpen(true);
      setBanner(message);
      lastDecision.current = null;
      pendingBle.current = null;
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
  const approvalById = useMemo(() => new Map(approvals.map((a) => [a.id, a])), [approvals]);

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

  const [geoFailure, setGeoFailure] = useState<GeoFailureKind | null>(null);
  const [locating, setLocating] = useState(false);
  type Shared = { imageUrl: string; result: VisionResult; kind: "photo" | "video_frame" };

  /**
   * Send, asking the device for a fix first when the message is about "my location" / "where I am"
   * (the model cannot read the browser's GPS). If that fails, send anyway: the agent replies with the
   * Share-my-location card, which shows why it failed and offers a city box.
   */
  const send = (text: string, location?: LocationQuery, profile?: HealthProfile, shared?: Shared) => {
    if (!location && !shared && shouldLocateBeforeSend(text, Boolean(status?.location))) {
      setBanner(null);
      setLocating(true);
      void getCurrentFix()
        .then((f) => {
          setGeoFailure(null);
          sendNow(text, { latitude: f.latitude, longitude: f.longitude, accuracyMeters: f.accuracy }, profile);
        })
        .catch((err: unknown) => {
          setGeoFailure(err instanceof GeoFailure ? err.kind : "unavailable");
          sendNow(text, undefined, profile);
        })
        .finally(() => setLocating(false));
      return;
    }
    sendNow(text, location, profile, shared);
  };

  const sendNow = (text: string, location?: LocationQuery, profile?: HealthProfile, shared?: Shared) => {
    setBanner(null);
    stopSpeaking();
    const scene: SessionScene | undefined = shared && {
      capturedAt: new Date().toISOString(),
      analysis: shared.result.analysis,
      overlay: { source: shared.result.overlay.source, labels: [...new Set(shared.result.overlay.regions.map((r) => r.label))].slice(0, 12) },
    };
    void sendMessage(
      { text, ...(shared ? { metadata: { scene: shared } } : {}) },
      { body: { location, profile, scene } satisfies SendBody },
    );
  };

  // Photo / video -> /api/vision (Muse Spark json_schema + SAM 3.1) -> agent turn with the structured scene.
  const judge = useJudgeMode();
  const [visionJob, setVisionJob] = useState<{ imageUrl?: string; stage: string; error?: string } | null>(null);
  const analyzeMedia = async (file: File, note: string) => {
    setBanner(null);
    setVisionJob({ stage: "Preparing your photo…" });
    try {
      const img = await prepareMedia(file);
      setVisionJob({ imageUrl: img.dataUrl, stage: img.kind === "video_frame" ? "Muse Spark is reading a frame from your video…" : "Muse Spark is reading the scene…" });
      const result = await apiFetch<VisionResult>("/api/vision", {
        method: "POST",
        body: JSON.stringify({ image: img.dataUrl, width: img.width, height: img.height, note: note || undefined, place: newsPlace }),
      });
      setVisionJob(null);
      const text =
        note ||
        (img.kind === "video_frame"
          ? "Here's a frame from a video of my space. Use what you see to engineer my indoor air."
          : "Here's a photo of my space. Use what you see to engineer my indoor air.");
      send(text, undefined, undefined, { imageUrl: img.dataUrl, result, kind: img.kind });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAccessOpen(true);
      setVisionJob((j) => ({ imageUrl: j?.imageUrl, stage: "", error: err instanceof Error ? err.message : "Photo analysis failed" }));
    }
  };
  // Live camera mode: each changed frame is read by Muse Spark + SAM; only plan-relevant changes start an agent turn.
  const liveBase = useRef<SceneAnalysis | null>(null);
  const liveBlocked = useRef<string | null>(null);
  useEffect(() => {
    liveBlocked.current = busy
      ? "Waiting for the current reply before the next read"
      : pending.length > 0
        ? "Approve or reject the pending device action first"
        : null;
  }, [busy, pending.length]);
  const analyzeLive = async (file: File, opts: { baseline: boolean; samChanges?: string[] }): Promise<LiveFrameResult> => {
    if (liveBlocked.current) return { kind: "skipped", message: liveBlocked.current };
    if (opts.baseline) liveBase.current = null;
    const img = await prepareMedia(file);
    let result: VisionResult;
    try {
      result = await apiFetch<VisionResult>("/api/vision", {
        method: "POST",
        body: JSON.stringify({ image: img.dataUrl, width: img.width, height: img.height, place: newsPlace, live: true }),
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAccessOpen(true);
      throw err;
    }
    const prev = liveBase.current;
    liveBase.current = result.analysis;
    const shared = { imageUrl: img.dataUrl, result, kind: "photo" as const };
    if (!prev) {
      send("Live camera: this is my space right now. Use what you see to engineer my indoor air.", undefined, undefined, shared);
      return { kind: "baseline" };
    }
    // SAM 3.1 mask changes (window/smoke/stove...) plus what Muse Spark reads from the same frame.
    const changes = [...new Set([...(opts.samChanges ?? []), ...sceneChanges(prev, result.analysis)])];
    if (changes.length === 0) return { kind: "unchanged" };
    send(liveChangeMessage(changes), undefined, undefined, shared);
    return { kind: "changed", changes };
  };
  const decide = (a: ApprovalView, decision: "approve" | "reject", note?: string) => {
    setReviewing(null);
    setBanner(null);
    lastDecision.current = decision;
    pendingBle.current = decision === "approve" ? a : null;
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

  // Rail: Briefing focuses the composer; Status / Plans open the news sidebar
  // (a drawer below 1180px) and move focus to that section's heading.
  const selectRail = (s: RailSection) => {
    if (s === "how") {
      setHowOpen(true);
      return;
    }
    setRailSection(s);
    if (s === "chat") {
      setSidebarOpen(false);
      document.getElementById("composer-input")?.focus();
      return;
    }
    setSidebarOpen(true);
    const target = document.getElementById(
      s === "status" ? "sb-air" : s === "news" ? "sb-news" : s === "devices" ? "sb-devices" : "sb-interventions",
    );
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Wait a frame so the drawer is visible before focusing inside it.
    requestAnimationFrame(() => {
      // Scroll only the sidebar: scrollIntoView would also scroll overflow-hidden ancestors (the app shell).
      const panel = document.getElementById("status-panel");
      if (target && panel) {
        const top = target.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 12;
        panel.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
      }
      target?.focus({ preventScroll: true });
    });
  };

  const history = status?.airQualityHistory ?? [];
  const placeLabel = status?.combined?.steps.find((x) => x.key === "location")?.detail;
  const newsPlace = status?.location?.name ?? status?.location?.area ?? undefined;
  const monitoringOn = Boolean(status?.monitoring?.enabled && status.location);
  const lastIsUser = messages.at(-1)?.role === "user";
  const askFlags = profileAskFlags(messages);
  const galleryScenes: GalleryScene[] = messages.flatMap((m) =>
    m.role === "user" && m.metadata?.scene?.imageUrl ? [{ id: m.id, imageUrl: m.metadata.scene.imageUrl, result: m.metadata.scene.result }] : [],
  );
  // Image mode in the prompt bar opens the newest reading's "air today" card builder.
  const openCard = () => {
    const btns = document.querySelectorAll<HTMLButtonElement>(".share-btn");
    btns[btns.length - 1]?.click();
  };
  const traceTotals = totalTraces(messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "data-trace" ? [p.data] : []))));

  const locationActions: LocationActions = {
    share: (location, label) => {
      setGeoFailure(null);
      sendNow(label, location);
    },
    known: status?.location ? (placeLabel ?? status.location.name ?? status.location.area ?? "your shared location") : null,
    busy: busy || locating,
    lastFailure: geoFailure,
  };

  return (
    <LocationActionsContext.Provider value={locationActions}>
    <div className="app">
      <a href="#composer-input" className="skip-link">
        Skip to message box
      </a>
      <Masthead
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
        hasConversation={Boolean(conversationId || messages.length)}
        judge={judge.on}
        onToggleJudge={judge.toggle}
      />
      <div className="workspace">
        <LeftRail active={howOpen ? "how" : railSection} onSelect={selectRail} pendingCount={pending.length} />
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
              {judge.on && <JudgePanel totals={traceTotals} onClose={() => judge.set(false)} />}
              <div className="chat-inner" role="log" aria-live="polite" aria-busy={busy} aria-label="Conversation">
                {restoring ? (
                  <LoadingState label="Restoring your conversation" />
                ) : messages.length === 0 ? (
                  <EmptyState
                    disabled={busy || locating}
                    onStart={({ message, location, profile, geoFailure: failed }) => {
                      setGeoFailure(failed ?? null);
                      sendNow(message, location, profile);
                    }}
                  />
                ) : (
                  <>
                    <header className="briefing-head">
                      <span className="kicker">
                        Live session
                        {placeLabel && (
                          <>
                            <span className="sep" aria-hidden="true" />
                            {placeLabel}
                          </>
                        )}
                      </span>
                      <h1>{status?.combined?.headline ?? "Your indoor-air control session"}</h1>
                      <hr className="rule-double" />
                    </header>
                    <StudioGallery scenes={galleryScenes} />
                    {messages.map((m, idx) => (
                      <MessageBubble
                        key={m.id}
                        isLast={idx === messages.length - 1}
                        message={m}
                        profileAskedBefore={askFlags.get(m.id) ?? false}
                        history={history}
                        busy={busy}
                        onReviewApproval={setReviewing}
                        approvalById={approvalById}
                        onRetry={retry}
                        judge={judge.on}
                        onSendText={(t) => send(t)}
                      />
                    ))}
                  </>
                )}
                {visionJob && (
                  <SceneProgress imageUrl={visionJob.imageUrl} stage={visionJob.stage} error={visionJob.error} onDismiss={() => setVisionJob(null)} />
                )}
                {locating && (
                  <div className="banner" data-tone="info" role="status">
                    <span>Asking your device for a position… (allow location when your browser asks)</span>
                  </div>
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
              disabled={busy || locating || pending.length > 0 || restoring || Boolean(visionJob && !visionJob.error)}
              busy={busy}
              onSend={(t, profile) => send(t, undefined, profile)}
              onAttach={(f, note) => void analyzeMedia(f, note)}
              onLiveFrame={analyzeLive}
              onCard={history.length > 0 ? openCard : undefined}
              showHealthChips={messages.length > 0}
              onStop={stop}
              disabledReason={pending.length > 0 ? "Approve or reject the pending device action to continue." : undefined}
            />
          </main>
        </div>
        <div className="backdrop" data-open={sidebarOpen} onClick={closeSidebar} aria-hidden="true" />
        <StatusSidebar
          status={status}
          loading={statusLoading}
          error={statusError}
          open={sidebarOpen}
          monitoring={monitoringOn}
          onClose={closeSidebar}
          onRecheck={recheck}
          rechecking={rechecking}
        >
          <NewsSection id="sb-news" title="News & talks">
            <NewsPanel place={newsPlace} />
          </NewsSection>
          <NewsSection id="sb-devices" title="Devices">
            <SmartPlugPanel conversationId={conversationId} />
            <BluetoothPanel onShareReadings={(t) => send(t)} canShare={!busy && pending.length === 0 && !restoring} />
          </NewsSection>
        </StatusSidebar>
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
    </LocationActionsContext.Provider>
  );
}

/**
 * For each assistant reply: did the reply before it (as shown, after dedupe) ask
 * for the sensitivity profile? Mirrors the server, which stores cleaned text.
 */
function profileAskFlags(messages: AgentUIMessage[]): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  let lastShownAsk = false;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    flags.set(m.id, lastShownAsk);
    const texts = m.parts.flatMap((p) => (p.type === "text" && !p.text.startsWith("**Monitoring update**") ? [p.text] : []));
    lastShownAsk = dedupeProfileAsks(texts, { alreadyAsked: lastShownAsk }).some((t) => asksForProfile(t));
  }
  return flags;
}
