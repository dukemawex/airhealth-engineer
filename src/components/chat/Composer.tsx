"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export function Composer({
  disabled,
  busy,
  onSend,
  onStop,
  disabledReason,
}: {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  disabledReason?: string;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
    ref.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="composer">
      <form onSubmit={submit} aria-label="Send a message">
        <label htmlFor="composer-input" className="sr-only">
          Message AirHealth Engineer
        </label>
        <textarea
          id="composer-input"
          ref={ref}
          className="textarea"
          rows={1}
          value={text}
          maxLength={8000}
          placeholder="Describe where you are, how you feel, or ask about your plan…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          aria-describedby="composer-hint"
        />
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
      <p id="composer-hint" className="composer-hint">
        {disabledReason ?? "Enter to send · Shift+Enter for a new line · Device actions always ask for your approval first."}
      </p>
    </div>
  );
}
