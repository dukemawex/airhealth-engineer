"use client";

import { useState, type FormEvent } from "react";
import type { LocationQuery } from "@/lib/domain";
import { Logo } from "../brand/Logo";

type Coords = { latitude: number; longitude: number };

/**
 * First-run screen: invites the user to share a location and health context.
 * Deliberately contains no example places or regional data.
 */
export function EmptyState({
  disabled,
  onStart,
}: {
  disabled: boolean;
  onStart: (args: { message: string; location?: LocationQuery }) => void;
}) {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [geoState, setGeoState] = useState<"idle" | "locating" | "error">("idle");
  const [geoError, setGeoError] = useState<string | null>(null);
  const [place, setPlace] = useState("");
  const [health, setHealth] = useState("");

  const locate = () => {
    if (!("geolocation" in navigator)) {
      setGeoState("error");
      setGeoError("This browser can't share location. Type your city or area instead.");
      return;
    }
    setGeoState("locating");
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ latitude: +pos.coords.latitude.toFixed(5), longitude: +pos.coords.longitude.toFixed(5) });
        setGeoState("idle");
      },
      (err) => {
        setGeoState("error");
        setGeoError(err.code === err.PERMISSION_DENIED ? "Location permission was denied. Type your city or area instead." : "Couldn't get your location. Type your city or area instead.");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  };

  const canStart = Boolean(coords || place.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    const where = place.trim() ? `I'm in ${place.trim()}.` : "I've shared my current coordinates.";
    const who = health.trim() ? ` My health context: ${health.trim()}.` : " I haven't shared any health details yet.";
    onStart({
      message: `${where}${who} Please check the air quality where I am and design an intervention to protect my health.`,
      location: coords ?? undefined,
    });
  };

  return (
    <section className="empty" aria-labelledby="empty-title">
      <Logo size={64} />
      <h1 id="empty-title">Engineer cleaner air for your health</h1>
      <p className="lede">
        Share where you are and anything relevant about your health. Muse Spark checks live air quality, designs a filtration,
        ventilation and exposure plan, and asks for your approval before touching any device.
      </p>
      <form className="empty-form" onSubmit={submit} aria-describedby="empty-privacy">
        <div className="field">
          <span id="loc-label" style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>
            Your location
          </span>
          <div className="or-row" role="group" aria-labelledby="loc-label">
            <button type="button" className="btn btn-secondary" onClick={locate} disabled={geoState === "locating" || disabled}>
              {geoState === "locating" ? "Locating…" : coords ? "Location shared ✓" : "Share my location"}
            </button>
            <span className="card-sub">or</span>
            <label htmlFor="place" className="sr-only">
              City, area or postcode
            </label>
            <input
              id="place"
              className="input"
              style={{ flex: 1, minWidth: 180 }}
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              placeholder="City, area or postcode"
              autoComplete="address-level2"
              maxLength={120}
            />
          </div>
          <span className="hint" aria-live="polite">
            {coords ? `Using ${coords.latitude}, ${coords.longitude}` : geoError ?? "Works anywhere with a nearby station or modelled data."}
          </span>
        </div>
        <div className="field">
          <label htmlFor="health">Health context (optional)</label>
          <textarea
            id="health"
            className="textarea"
            rows={3}
            value={health}
            onChange={(e) => setHealth(e.target.value)}
            maxLength={1500}
            placeholder="Conditions, symptoms, age group, medications or plans for today"
            aria-describedby="health-hint"
          />
          <span id="health-hint" className="hint">
            Used only to tailor thresholds and precautions. Not a diagnosis.
          </span>
        </div>
        <div className="actions" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <span id="empty-privacy" className="card-sub">
            Or just type in the box below.
          </span>
          <button type="submit" className="btn btn-primary" disabled={!canStart || disabled}>
            Start assessment
          </button>
        </div>
      </form>
    </section>
  );
}
