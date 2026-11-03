"use client";

import { useEffect } from "react";

export function LoadingState({ label = "Muse Spark is thinking" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="typing" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label}…
    </div>
  );
}

export function SuccessToast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#5eead4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m5 12 5 5 9-10" />
      </svg>
      {message}
    </div>
  );
}
