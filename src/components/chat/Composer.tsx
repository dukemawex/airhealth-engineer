"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSpeakPreference } from "@/lib/client/speech";
import { useVoiceInput } from "@/lib/client/voice";
import type { HealthProfile } from "@/lib/domain";
import { activeChips, composerContext, profileFromChips, toggleComposerChip } from "@/lib/healthChips";
import { HealthChips } from "./HealthChips";

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
}: {
  /** Photo or video chosen: the current text is passed along as the note. */
  onAttach?: (file: File, note: string) => void;
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
  const dictation = useVoiceInput((heard) => {
    if (!heard) return;
    setText((t) => (t.trim() ? `${t.trimEnd()} ${heard}` : heard));
    ref.current?.focus();
  });
  const speakPref = useSpeakPreference();

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
  const hint =
    dictation.error ??
    disabledReason ??
    "Enter to send · Shift+Enter for a new line · Device actions always ask for your approval first.";
  return (
    <div className="composer" data-listening={dictation.listening || dictation.transcribing}>
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
      <form onSubmit={submit} aria-label="Send a message">
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
            placeholder={dictation.listening ? "Listening… speak now" : "Describe where you are, how you feel, or ask about your plan…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            aria-describedby="composer-hint composer-interim"
          />
          <p id="composer-interim" className="composer-interim" aria-live="polite">
            {dictation.listening || dictation.transcribing ? dictation.interim || "Listening…" : ""}
          </p>
        </div>
        {onAttach && (
          <>
            <button
              type="button"
              className="btn btn-secondary icon-btn attach-btn"
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
              aria-label="Add a photo or video of your space"
              title="Snap or upload a photo or short video of your space"
            >
              <CameraIcon />
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
                if (!f || disabled) return;
                if (dictation.listening) dictation.stop();
                onAttach(f, text.trim());
                setText("");
              }}
            />
          </>
        )}
        {dictation.supported && (
          <button
            type="button"
            className="btn btn-secondary icon-btn mic-btn"
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
          </button>
        )}
        {busy ? (
          <button type="button" className="btn btn-secondary" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={disabled || !text.trim()}>
            Send
          </button>
        )}
      </form>
      <div className="composer-meta">
        <p id="composer-hint" className="composer-hint" data-tone={dictation.error ? "error" : undefined}>
          {hint}
        </p>
        {showHealthChips && (
          <button
            type="button"
            className="speak-toggle"
            aria-expanded={chipsOpen}
            aria-controls="composer-chips"
            onClick={() => setChipsOpen((o) => !o)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 21s-7.5-4.6-9.3-9.6C1.4 7.6 4 4 7.5 4c2 0 3.5 1.1 4.5 2.6C13 5.1 14.5 4 16.5 4 20 4 22.6 7.6 21.3 11.4 19.5 16.4 12 21 12 21Z" />
            </svg>
            <span>Health context</span>
          </button>
        )}
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
