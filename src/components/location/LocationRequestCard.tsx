"use client";

import { useState, type FormEvent } from "react";
import { GeoFailure, geoHelp, getCurrentFix, type GeoFailureKind } from "@/lib/client/geolocation";
import { useLocationActions } from "./LocationContext";

/**
 * Inline "Share my location" card: one tap for device geolocation, or type a city.
 * Rendered for the requestLocation tool, for tools that return needsLocation, and as
 * a client fallback when the reply asks for a place. Sharing posts the location with
 * a short message, which resumes the agent on the user's original question.
 */
export function LocationRequestCard({ reason, live = true }: { reason?: string; live?: boolean }) {
  const actions = useLocationActions();
  const [state, setState] = useState<"idle" | "locating" | "sent">("idle");
  const [failure, setFailure] = useState<GeoFailureKind | null>(null);
  const [city, setCity] = useState("");
  const shownFailure = failure ?? (state === "idle" ? actions?.lastFailure ?? null : null);
  const help = shownFailure ? geoHelp(shownFailure) : null;
  const known = actions?.known;
  const disabled = !actions || actions.busy || state !== "idle";

  if (!live || (known && state !== "sent")) {
    return (
      <section className="card loc-card" data-done="true" aria-label="Location">
        <span className="kicker">Location</span>
        <p className="loc-done">{known ? `Using ${known}.` : "Location requested."}</p>
      </section>
    );
  }

  const shareDevice = async () => {
    if (!actions) return;
    setState("locating");
    setFailure(null);
    try {
      const f = await getCurrentFix();
      setState("sent");
      actions.share({ latitude: f.latitude, longitude: f.longitude, accuracyMeters: f.accuracy }, "Here's my device location. Please continue.");
    } catch (err) {
      setFailure(err instanceof GeoFailure ? err.kind : "unavailable");
      setState("idle");
    }
  };

  const submitCity = (e: FormEvent) => {
    e.preventDefault();
    const c = city.trim();
    if (!actions || c.length < 2) return;
    setState("sent");
    actions.share({ city: c }, `I'm in ${c}. Please continue.`);
  };

  return (
    <section className="card loc-card" aria-label="Share your location">
      <div className="card-header">
        <div>
          <span className="kicker">Location needed</span>
          <h3 className="card-title">Where should I check the air?</h3>
        </div>
      </div>
      <p className="card-sub">{reason ? `I need a place ${reason.replace(/^to\s+/i, "to ")}.` : "Share your location for the nearest station, or type a place."}</p>
      {state === "sent" ? (
        <p className="loc-done" role="status">Location shared. Continuing…</p>
      ) : (
        <>
          <div className="loc-actions">
            <button type="button" className="btn btn-primary" onClick={() => void shareDevice()} disabled={disabled} aria-describedby={help ? "loc-help" : undefined}>
              {state === "locating" ? "Finding you…" : "Share my location"}
            </button>
          </div>
          <form className="loc-city" onSubmit={submitCity}>
            <label htmlFor="loc-city-input" className="sr-only">
              City, area or postcode
            </label>
            <input
              id="loc-city-input"
              className="input"
              placeholder="or type a city, area or postcode"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              disabled={disabled}
              autoComplete="address-level2"
            />
            <button type="submit" className="btn btn-secondary" disabled={disabled || city.trim().length < 2}>
              Use this place
            </button>
          </form>
          {help && (
            <div id="loc-help" className="loc-help" role="alert">
              <strong>{help.message}</strong>
              {help.hint && <span>{help.hint}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
