"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { LocationQuery } from "@/lib/domain";
import { useToday } from "@/lib/client/useToday";

type Coords = { latitude: number; longitude: number };

const TILES: Array<{ title: string; body: string; icon: ReactNode }> = [
  {
    title: "Measure",
    body: "Live readings from the nearest OpenAQ station, or clearly labelled modelled data.",
    icon: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  },
  {
    title: "Engineer",
    body: "Filter class, purifier CADR, ventilation timing and safer routes, with the maths shown.",
    icon: (
      <>
        <path d="M4 7h10M4 12h16M4 17h7" />
        <circle cx="17" cy="7" r="2" />
        <circle cx="14" cy="17" r="2" />
      </>
    ),
  },
  {
    title: "Approve & monitor",
    body: "Nothing touches a device until you approve it. Then the air keeps being checked.",
    icon: (
      <>
        <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
];

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
  const today = useToday();

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
    <section className="front" aria-labelledby="empty-title">
      <header className="front-head">
        <span className="kicker">
          Today&apos;s briefing<span className="sep" aria-hidden="true" />
          <span className="dateline" suppressHydrationWarning>
            {today || "Live"}
          </span>
        </span>
        <h1 id="empty-title">Engineer cleaner air for your health</h1>
        <p className="standfirst">
          Share where you are and anything relevant about your health. Muse Spark checks live air quality, designs a filtration,
          ventilation and exposure plan, and asks for your approval before touching any device.
        </p>
        <hr className="rule-double" />
      </header>
      <div className="front-grid">
        <form className="empty-form" onSubmit={submit} aria-labelledby="start-title" aria-describedby="empty-privacy">
          <h2 id="start-title">Start your briefing</h2>
          <div className="field">
            <span id="loc-label" style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>
              Your location
            </span>
            <div className="or-row" role="group" aria-labelledby="loc-label">
              <button type="button" className="btn btn-secondary" onClick={locate} disabled={geoState === "locating" || disabled}>
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
                  <circle cx="12" cy="9.5" r="2.5" />
                </svg>
                {geoState === "locating" ? "Locating…" : coords ? "Location shared ✓" : "Share my location"}
              </button>
              <span className="or" aria-hidden="true">
                or
              </span>
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
          <div className="actions" style={{ justifyContent: "space-between" }}>
            <span id="empty-privacy" className="card-sub">
              Or just type in the box below.
            </span>
            <button type="submit" className="btn btn-primary" disabled={!canStart || disabled}>
              Start assessment
            </button>
          </div>
        </form>
        <aside aria-labelledby="method-title">
          <h2 id="method-title" className="kicker" style={{ marginBottom: "var(--space-3)" }}>
            In this briefing
          </h2>
          <ul className="tiles">
            {TILES.map((t) => (
              <li className="tile" key={t.title}>
                <span className="tile-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    {t.icon}
                  </svg>
                </span>
                <span>
                  <h3>{t.title}</h3>
                  <p>{t.body}</p>
                </span>
              </li>
            ))}
          </ul>
          <p className="front-note">Decision support only, not medical advice. Seek urgent care for severe symptoms.</p>
        </aside>
      </div>
    </section>
  );
}
