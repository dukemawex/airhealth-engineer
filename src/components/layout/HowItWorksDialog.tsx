"use client";

import { useEffect, useRef } from "react";

export function HowItWorksDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal wide" aria-labelledby="how-title" onClose={onClose}>
      <div className="modal-body">
        <div className="modal-header">
          <div>
            <span className="kicker">The method</span>
            <h2 id="how-title">How it works</h2>
          </div>
          <button type="button" className="btn btn-ghost icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <ol className="steps">
          <li>
            <strong>You describe your situation</strong> in plain language: where you are, your room, and an optional sensitivity profile that only tunes device thresholds (not medical advice).
          </li>
          <li>
            <strong>Muse Spark plans the next step.</strong> Every reasoning step is a call to Meta&apos;s Muse Spark model through the
            Meta Model API (Chat Completions with tool calling). No other language model is used.
          </li>
          <li>
            <strong>Tools fetch real data.</strong> <em>getAirQuality</em> geocodes your location and reads the nearest OpenAQ
            station (or modelled CAMS data, clearly labelled, if no station is nearby). <em>getHealthContext</em> records what you
            shared and flags red-flag symptoms.
          </li>
          <li>
            <strong>An engineered plan.</strong> <em>designIntervention</em> validates the plan and computes checks such as
            required purifier CADR (room volume × target air changes per hour), filter class, ventilation timing and safer
            routes.
          </li>
          <li>
            <strong>Human approval gate.</strong> Any device change (purifier, HVAC, window) goes through{" "}
            <em>executeDeviceAction</em>, which never runs directly: the run pauses, the request is saved, and you approve or
            reject it here. Only an approval executes it (simulated in sandbox mode); a rejection is reported back to the agent.
          </li>
          <li>
            <strong>Monitoring.</strong> The app re-checks air quality for your conversation (from this page and a scheduled
            job). Muse Spark decides whether the change is worth telling you about.
          </li>
        </ol>
        <p className="card-sub">
          Your conversation is stored on the server so it survives reloads and approvals. Decision support only, not medical
          advice: seek urgent care for severe symptoms.
        </p>
        <div className="modal-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </dialog>
  );
}
