"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAMERA_MESSAGES,
  type CameraProblem,
  cameraConstraints,
  cameraPrecheck,
  captureFileName,
  captureSize,
  classifyCameraError,
  type Facing,
  isIOS,
  otherFacing,
  trackHasTorch,
} from "@/lib/client/camera";
import { decideLiveTick, frameDiff, initialLiveState, LIVE_DEFAULTS, lumaSignature } from "@/lib/liveScene";

/** What the app did with one live frame. */
export type LiveFrameResult =
  | { kind: "baseline" }
  | { kind: "changed"; changes: string[] }
  | { kind: "unchanged" }
  | { kind: "skipped"; message: string };

type LiveEvent = { id: number; at: string; tone: "info" | "change" | "warn"; text: string };

const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

type Phase = "starting" | "live" | "captured" | "error";

function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const ICONS = {
  close: "M6 6l12 12M18 6 6 18",
  flip: "M4 9a8 8 0 0 1 14-3l2 2M20 4v4h-4M20 15a8 8 0 0 1-14 3l-2-2M4 20v-4h4",
  torch: "M9 2h6l-1 7h4L9 22l2-9H7z",
  retake: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  use: "M5 12l5 5L20 7",
};

/**
 * Live in-app camera: a studio-styled native <dialog> (focus trap, Esc closes)
 * with a getUserMedia preview, shutter, retake/use, switch camera and torch.
 * The captured frame is handed back as a JPEG File and goes through the same
 * Muse Spark vision → SAM 3.1 → approval-gated device pipeline as an upload.
 */
export function CameraSheet({
  open,
  onClose,
  onCapture,
  onFallback,
  onLiveFrame,
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  /** Open the OS camera / file picker instead (shown when live capture fails). */
  onFallback: () => void;
  /** Live mode: analyse a frame (Muse Spark + SAM) and update the plan if the scene changed. */
  onLiveFrame?: (file: File, opts: { baseline: boolean }) => Promise<LiveFrameResult>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shutterRef = useRef<HTMLButtonElement>(null);
  const useRef_ = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const [facing, setFacing] = useState<Facing>("environment");
  const [canFlip, setCanFlip] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [shot, setShot] = useState<{ url: string; blob: Blob } | null>(null);
  const [flash, setFlash] = useState(false);
  const [live, setLive] = useState(false);
  const [liveNote, setLiveNote] = useState<string>("");
  const [reads, setReads] = useState(0);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const liveState = useRef(initialLiveState());
  const lastSig = useRef<Float32Array | null>(null);
  const eventId = useRef(0);
  const onLiveRef = useRef(onLiveFrame);
  useEffect(() => {
    onLiveRef.current = onLiveFrame;
  }, [onLiveFrame]);
  const pushEvent = useCallback((tone: LiveEvent["tone"], text: string) => {
    eventId.current += 1;
    const ev = { id: eventId.current, at: clock(), tone, text };
    setEvents((e) => [ev, ...e].slice(0, 6));
  }, []);

  /** Stop every track (turns the camera light off). No state updates, safe in effects. */
  const genRef = useRef(0);
  const release = useCallback(() => {
    genRef.current += 1; // invalidates any getUserMedia still in flight
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const stop = useCallback(() => {
    release();
    setTorchOn(false);
    setTorchOk(false);
  }, [release]);

  const start = useCallback(
    async (f: Facing) => {
      stop();
      const gen = genRef.current;
      setPhase("starting");
      setProblem(null);
      const pre = cameraPrecheck({
        isSecureContext: typeof window !== "undefined" ? window.isSecureContext : undefined,
        hasGetUserMedia: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
      });
      if (pre) {
        setProblem(pre);
        setPhase("error");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(f));
        if (gen !== genRef.current) {
          // Closed or restarted while the permission prompt was up: never leave a camera on.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          // iOS Safari only plays inline, muted, with these set before play().
          v.setAttribute("playsinline", "true");
          v.muted = true;
          v.srcObject = stream;
          await v.play().catch(() => undefined);
        }
        const track = stream.getVideoTracks()[0];
        const caps = typeof track?.getCapabilities === "function" ? track.getCapabilities() : undefined;
        setTorchOk(trackHasTorch(caps));
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        const cams = devices.filter((d) => d.kind === "videoinput").length;
        setCanFlip(cams > 1 || (cams === 0 && isIOS(navigator.userAgent, navigator.maxTouchPoints)));
        setPhase("live");
        requestAnimationFrame(() => shutterRef.current?.focus());
      } catch (err) {
        if (gen !== genRef.current) return;
        stop();
        setProblem(classifyCameraError(err));
        setPhase("error");
      }
    },
    [stop],
  );

  // Open / close the dialog and the stream together.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open) {
      if (!d.open) d.showModal();
      // Start on open; state updates happen after the async getUserMedia call.
      queueMicrotask(() => void start("environment"));
    } else {
      release();
      if (d.open) d.close();
    }
  }, [open, start, release]);

  // Always release the camera if the sheet unmounts or the tab is hidden.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && streamRef.current) {
        release();
        setLive(false);
        setPhase("error");
        setProblem("aborted");
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      release();
    };
  }, [release]);

  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url);
  }, [shot]);

  const close = () => {
    stop();
    setLive(false);
    setEvents([]);
    setLiveNote("");
    setShot(null);
    setFacing("environment");
    onClose();
  };

  // Live mode loop: a 32x24 thumbnail diff every few seconds; a vision call only when the scene changed.
  useEffect(() => {
    if (!live || phase !== "live") return;
    let cancelled = false;
    const thumb = document.createElement("canvas");
    thumb.width = LIVE_DEFAULTS.thumbW;
    thumb.height = LIVE_DEFAULTS.thumbH;
    const tctx = thumb.getContext("2d", { willReadFrequently: true });
    const grab = (v: HTMLVideoElement) =>
      new Promise<File | null>((resolve) => {
        const { width, height } = captureSize(v.videoWidth, v.videoHeight);
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        const ctx = c.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(v, 0, 0, width, height);
        c.toBlob((b) => resolve(b ? new File([b], captureFileName(new Date()), { type: "image/jpeg" }) : null), "image/jpeg", 0.85);
      });
    const tick = async () => {
      const v = videoRef.current;
      const handler = onLiveRef.current;
      if (cancelled || !v || !v.videoWidth || !streamRef.current || !tctx || !handler) return;
      tctx.drawImage(v, 0, 0, thumb.width, thumb.height);
      const sig = lumaSignature(tctx.getImageData(0, 0, thumb.width, thumb.height).data, thumb.width * thumb.height);
      const diff = lastSig.current ? frameDiff(lastSig.current, sig) : null;
      const d = decideLiveTick(liveState.current, Date.now(), diff);
      if (!d.analyze) {
        if (d.reason === "budget_spent") {
          setLive(false);
          pushEvent("warn", `Live mode paused: ${LIVE_DEFAULTS.maxAnalyses} scene reads used. Turn it on again to continue.`);
        } else if (d.reason === "unchanged") setLiveNote("Watching: no change in view");
        else if (d.reason === "cooldown") setLiveNote("Change seen: waiting a few seconds before the next read");
        return;
      }
      liveState.current = { ...liveState.current, inFlight: true };
      setLiveNote(d.reason === "baseline" ? "Reading the scene…" : "Scene changed: re-reading…");
      try {
        const file = await grab(v);
        if (!file || cancelled) {
          liveState.current = { ...liveState.current, inFlight: false };
          return;
        }
        const r = await handler(file, { baseline: d.reason === "baseline" });
        if (cancelled) return;
        if (r.kind === "skipped") {
          // Nothing was sent: keep the old baseline so the change is picked up later.
          liveState.current = { ...liveState.current, inFlight: false };
          setLiveNote(r.message);
          return;
        }
        liveState.current = { analyses: liveState.current.analyses + 1, lastAnalysisAt: Date.now(), inFlight: false };
        lastSig.current = sig;
        setReads(liveState.current.analyses);
        if (r.kind === "baseline") pushEvent("info", "Scene read → plan started");
        else if (r.kind === "changed") pushEvent("change", `Scene changed → plan updated: ${r.changes.join("; ")}`);
        else pushEvent("info", "Movement seen, nothing that changes the plan");
        setLiveNote("Watching");
      } catch (err) {
        if (cancelled) return;
        liveState.current = { ...liveState.current, inFlight: false };
        const m = err instanceof Error ? err.message : "Live read failed";
        pushEvent("warn", m);
        if (/limit|429/i.test(m)) setLive(false);
      }
    };
    const first = setTimeout(() => void tick(), 400);
    const id = setInterval(() => void tick(), LIVE_DEFAULTS.tickMs);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [live, phase, pushEvent]);

  const toggleLive = () => {
    if (live) {
      setLive(false);
      setLiveNote("");
      return;
    }
    liveState.current = initialLiveState();
    lastSig.current = null;
    setReads(0);
    setEvents([]);
    setLiveNote("Starting live mode…");
    setLive(true);
  };

  const flip = () => {
    const f = otherFacing(facing);
    setFacing(f);
    void start(f);
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchOk(false);
    }
  };

  const capture = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const { width, height } = captureSize(v.videoWidth, v.videoHeight);
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    // Front camera previews mirrored; save the true (unmirrored) frame.
    ctx.drawImage(v, 0, 0, width, height);
    c.toBlob(
      (blob) => {
        if (!blob) return;
        setShot({ url: URL.createObjectURL(blob), blob });
        setPhase("captured");
        setFlash(true);
        setTimeout(() => setFlash(false), 220);
        requestAnimationFrame(() => useRef_.current?.focus());
      },
      "image/jpeg",
      0.9,
    );
  };

  const retake = () => {
    setShot(null);
    setPhase("live");
    requestAnimationFrame(() => shutterRef.current?.focus());
  };

  const usePhoto = () => {
    if (!shot) return;
    const file = new File([shot.blob], captureFileName(new Date()), { type: "image/jpeg" });
    close();
    onCapture(file);
  };

  const msg = problem ? CAMERA_MESSAGES[problem] : null;

  return (
    <dialog
      ref={dialogRef}
      className="camera-sheet"
      aria-labelledby="camera-title"
      aria-describedby="camera-desc"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) close();
      }}
    >
      <div className="camera-inner">
        <header className="camera-head">
          <div>
            <p className="eyebrow camera-eyebrow">
              <span className="dot" aria-hidden="true" /> Live camera · SAM 3.1
            </p>
            <h2 id="camera-title" className="camera-title">
              Snap your room
            </h2>
            <p id="camera-desc" className="camera-desc">
              Frame windows, vents, the purifier and any haze. Muse Spark reads the scene, SAM 3.1 outlines it, and device actions still wait for your approval.
            </p>
          </div>
          {onLiveFrame && (
            <button
              type="button"
              role="switch"
              aria-checked={live}
              className="live-toggle"
              data-on={live}
              onClick={toggleLive}
              disabled={phase !== "live"}
              title="Re-read the scene every few seconds, only when it changes"
            >
              <span className="live-knob" aria-hidden="true" /> Live
            </button>
          )}
          <button type="button" className="btn btn-secondary icon-btn camera-close" onClick={close} aria-label="Close camera">
            <Icon d={ICONS.close} />
          </button>
        </header>

        <div className="camera-stage" data-phase={phase} data-facing={facing}>
          <video
            ref={videoRef}
            className="camera-video"
            playsInline
            muted
            autoPlay
            aria-label={phase === "live" ? `Live preview from the ${facing === "environment" ? "rear" : "front"} camera` : undefined}
            hidden={phase === "captured" || phase === "error"}
          />
          {shot && phase === "captured" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="camera-shot" src={shot.url} alt="Captured photo of your room, ready to analyse" />
          )}
          {phase === "starting" && (
            <p className="camera-status" role="status">
              Starting the camera… allow access if your browser asks.
            </p>
          )}
          {phase === "error" && msg && (
            <div className="camera-error" role="alert">
              <h3>{msg.title}</h3>
              <p>{msg.body}</p>
              <div className="camera-error-actions">
                {problem !== "insecure" && problem !== "unsupported" && problem !== "no-camera" && (
                  <button type="button" className="btn btn-secondary" onClick={() => void start(facing)}>
                    Try again
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    close();
                    onFallback();
                  }}
                >
                  Use camera app or upload
                </button>
              </div>
            </div>
          )}
          {phase === "live" && <div className="camera-frame" aria-hidden="true" />}
          {(live || events.length > 0) && (
            <div className="live-panel" data-testid="live-panel">
              {live && (
                <p className="live-status" role="status">
                  <span className="live-dot" aria-hidden="true" /> {liveNote || "Watching"} · {reads}/{LIVE_DEFAULTS.maxAnalyses} reads
                </p>
              )}
              <ol className="live-events" aria-live="polite" aria-label="Live scene events">
                {events.map((e) => (
                  <li key={e.id} data-tone={e.tone}>
                    <time>{e.at}</time> {e.text}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {flash && <div className="camera-flash" aria-hidden="true" />}
        </div>

        <div className="camera-controls">
          {phase === "captured" ? (
            <>
              <button type="button" className="btn btn-secondary btn-lg" onClick={retake}>
                <Icon d={ICONS.retake} /> Retake
              </button>
              <button ref={useRef_} type="button" className="btn btn-primary btn-lg" onClick={usePhoto}>
                <Icon d={ICONS.use} /> Use photo
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-secondary icon-btn camera-side"
                onClick={toggleTorch}
                disabled={!torchOk || phase !== "live"}
                aria-pressed={torchOn}
                aria-label={torchOk ? (torchOn ? "Turn torch off" : "Turn torch on") : "Torch not available on this camera"}
                title={torchOk ? "Torch" : "Torch not available on this camera"}
              >
                <Icon d={ICONS.torch} />
              </button>
              <button
                ref={shutterRef}
                type="button"
                className="shutter"
                onClick={capture}
                disabled={phase !== "live"}
                aria-label="Take photo"
              >
                <span aria-hidden="true" />
              </button>
              <button
                type="button"
                className="btn btn-secondary icon-btn camera-side"
                onClick={flip}
                disabled={!canFlip || phase === "starting"}
                aria-label={`Switch to the ${facing === "environment" ? "front" : "rear"} camera`}
                title="Switch camera"
              >
                <Icon d={ICONS.flip} />
              </button>
            </>
          )}
        </div>
        <p className="camera-note">
          The camera turns off when you close this sheet or switch tabs.{" "}
          {live
            ? `Live mode sends a frame only when the scene changes (at most ${LIVE_DEFAULTS.maxAnalyses} reads); device actions still wait for your approval.`
            : "Photos are only sent when you tap Use photo or turn on Live."}
        </p>
      </div>
    </dialog>
  );
}
