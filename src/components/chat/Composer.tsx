"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSpeakPreference } from "@/lib/client/speech";
import { useVoiceInput } from "@/lib/client/voice";
import type { HealthProfile } from "@/lib/domain";
import { activeChips, composerContext, profileFromChips, toggleComposerChip } from "@/lib/healthChips";
import { CameraSheet, type LiveFrameResult } from "@/components/camera/CameraSheet";
import { HealthChips } from "./HealthChips";

function ImageIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5-9 9" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      {on ? <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /> : <path d="m17 9 5 6M22 9l-5 6" />}
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="3" width="14" height="18" rx="3" />
      <circle cx="12" cy="9.5" r="2.5" />
      <path d="M8.5 15h7M9.5 18h5" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  );
}

export function Composer({
  disabled,
  busy,
  onSend,
  onStop,
  disabledReason,
  showHealthChips = false,
  onAttach,
  onLiveFrame,
  onCard,
}: {
  /** Image mode: open the Muse Image "air today" card for the latest reading (absent until there is one). */
  onCard?: () => void;
  /** Photo or video chosen: the current text is passed along as the note. */
  onAttach?: (file: File, note: string) => void;
  /** Live camera mode handler (scene re-reads that update the plan). */
  onLiveFrame?: (file: File, opts: { baseline: boolean }) => Promise<LiveFrameResult>;
  disabled: boolean;
  busy: boolean;
  onSend: (text: string, profile?: HealthProfile) => void;
  showHealthChips?: boolean;
  onStop: () => void;
  disabledReason?: string;
}) {
  const [text, setText] = useState("");
  const [chipsOpen, setChipsOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Mobile fallback: the OS camera app via capture="environment". */
  const captureRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const dictation = useVoiceInput((heard) => {
    if (!heard) return;
    setText((t) => (t.trim() ? `${t.trimEnd()} ${heard}` : heard));
    ref.current?.focus();
  });
  const speakPref = useSpeakPreference();

  // The studio hero's "Snap your room" / "Speak" buttons drive the same single input pipeline.
  const startVoice = dictation.start;
  useEffect(() => {
    const attach = () => fileRef.current?.click();
    const voice = () => startVoice();
    const camera = () => setCameraOpen(true);
    window.addEventListener("airhealth:attach", attach);
    window.addEventListener("airhealth:voice", voice);
    window.addEventListener("airhealth:camera", camera);
    return () => {
      window.removeEventListener("airhealth:attach", attach);
      window.removeEventListener("airhealth:voice", voice);
      window.removeEventListener("airhealth:camera", camera);
    };
  }, [startVoice]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    if (dictation.listening) dictation.stop();
    onSend(t, profileFromChips(activeChips(composerContext(t))));
    setText("");
    setChipsOpen(false);
    ref.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const attachFile = (f: File | undefined) => {
    if (!f || disabled || !onAttach) return;
    if (dictation.listening) dictation.stop();
    onAttach(f, text.trim());
    setText("");
  };
  const hint =
    dictation.error ??
    disabledReason ??
    "Enter to send · Shift+Enter for a new line · Device actions always ask for your approval first.";
  return (
    <div className="composer prompt-bar" data-listening={dictation.listening || dictation.transcribing}>
      {showHealthChips && chipsOpen && (
        <div id="composer-chips" className="composer-chips">
          <HealthChips
            compact
            text={composerContext(text)}
            disabled={disabled}
            onToggle={(c) => {
              setText((t) => toggleComposerChip(t, c));
              ref.current?.focus();
            }}
          />
        </div>
      )}
      <form onSubmit={submit} aria-label="Send a message" className="prompt-shell">
        <label htmlFor="composer-input" className="sr-only">
          Message AirHealth Engineer
        </label>
        <div className="composer-field">
          <textarea
            id="composer-input"
            ref={ref}
            className="textarea"
            rows={1}
            value={text}
            maxLength={8000}
            placeholder={dictation.listening ? "Listening… speak now" : "Where are you, what's the room like, what should the devices do?"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            aria-describedby="composer-hint composer-interim"
          />
          <p id="composer-interim" className="composer-interim" aria-live="polite">
            {dictation.listening || dictation.transcribing ? dictation.interim || "Listening…" : ""}
          </p>
        </div>
        <div className="prompt-row">
          <div className="mode-chips" role="group" aria-label="Meta models and input modes">
            <span className="mode-chip" data-static="true" title="Every reasoning step runs on Meta Muse Spark">
              <SparkIcon />
              Muse Spark
            </span>
            {onAttach && (
              <>
                <button
                  type="button"
                  className="mode-chip camera-btn"
                  onClick={() => setCameraOpen(true)}
                  disabled={disabled}
                  aria-haspopup="dialog"
                  aria-expanded={cameraOpen}
                  aria-label="Open the live camera (photo outlined by SAM 3.1)"
                  title="Take a photo of your space with the live camera. Muse Spark reads it and SAM 3.1 outlines haze, windows and devices."
                >
                  <CameraIcon />
                  <span>Camera</span>
                </button>
                <button
                  type="button"
                  className="mode-chip attach-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={disabled}
                  aria-label="Upload a photo or video of your space (outlined by SAM 3.1)"
                  title="Upload a photo or short video of your space. SAM 3.1 outlines haze, windows and devices."
                >
                  <ImageIcon />
                  <span>
                    Photo <span className="chip-model">SAM 3.1</span>
                  </span>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/*"
                  hidden
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    attachFile(f);
                  }}
                />
                <input
                  ref={captureRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  tabIndex={-1}
                  aria-hidden="true"
                  data-testid="camera-fallback-input"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    attachFile(f);
                  }}
                />
                <CameraSheet
                  open={cameraOpen}
                  onClose={() => setCameraOpen(false)}
                  onCapture={(f) => attachFile(f)}
                  onFallback={() => captureRef.current?.click()}
                  onLiveFrame={onLiveFrame}
                />
              </>
            )}
            {dictation.supported && (
              <button
                type="button"
                className="mode-chip mic-btn"
                onClick={dictation.listening ? dictation.stop : dictation.start}
                aria-pressed={dictation.listening}
                aria-label={dictation.listening ? "Stop voice input" : "Speak your message"}
                title={
                  dictation.listening
                    ? "Stop voice input"
                    : dictation.engine === "muse"
                      ? "Speak your message (transcribed by Muse Voice Transcribe)"
                      : "Speak your message (browser dictation)"
                }
                data-engine={dictation.engine}
                aria-busy={dictation.transcribing}
                disabled={(disabled && !dictation.listening) || dictation.transcribing}
              >
                <MicIcon />
                <span aria-hidden="true">
                  {dictation.listening ? "Stop" : "Voice"} <span className="chip-model">{dictation.engine === "muse" ? "Muse" : "Web"}</span>
                </span>
              </button>
            )}
            {onCard && (
              <button
                type="button"
                className="mode-chip"
                onClick={onCard}
                title="Make a shareable “air today” card with Muse Image from your latest reading"
              >
                <CardIcon />
                <span>
                  Air card <span className="chip-model">Muse Image</span>
                </span>
              </button>
            )}
            {showHealthChips && (
              <button
                type="button"
                className="mode-chip"
                aria-expanded={chipsOpen}
                aria-controls="composer-chips"
                onClick={() => setChipsOpen((o) => !o)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h10M4 12h16M4 17h7" />
                  <circle cx="17" cy="7" r="2" />
                  <circle cx="14" cy="17" r="2" />
                </svg>
                <span>Sensitivity</span>
              </button>
            )}
          </div>
          {busy ? (
            <button type="button" className="btn btn-secondary send-btn" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary send-btn" disabled={disabled || !text.trim()}>
              <span>Send</span>
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          )}
        </div>
      </form>
      <div className="composer-meta">
        <p id="composer-hint" className="composer-hint" data-tone={dictation.error ? "error" : undefined}>
          {hint}
        </p>
        {speakPref.supported && (
          <button
            type="button"
            className="speak-toggle"
            aria-pressed={speakPref.on}
            onClick={() => speakPref.set(!speakPref.on)}
            title="Read Muse Spark's replies aloud on this device"
          >
            <SpeakerIcon on={speakPref.on} />
            <span>Read replies aloud</span>
          </button>
        )}
      </div>
    </div>
  );
}
