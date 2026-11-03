"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type { HealthProfile, LocationQuery } from "@/lib/domain";
import { activeChips, profileFromChips, STARTER_PROMPTS, toggleChipText } from "@/lib/healthChips";
import { HealthChips } from "@/components/chat/HealthChips";
import { ApiError } from "@/lib/client/api";
import { GeoFailure, getCurrentFix, type Fix } from "@/lib/client/geolocation";
import { previewPlace } from "@/lib/client/resolvePlace";
import { useToday } from "@/lib/client/useToday";

type Preview =
  | { status: "idle" | "checking" }
  | { status: "found"; label: string; accuracyNote?: string }
  | { status: "notfound"; message: string };

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
  onStart: (args: { message: string; location?: LocationQuery; profile?: HealthProfile }) => void;
}) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [fixLabel, setFixLabel] = useState<string | null>(null);
  const [geoState, setGeoState] = useState<"idle" | "locating" | "naming" | "error">("idle");
  const [geoError, setGeoError] = useState<string | null>(null);
  const [place, setPlace] = useState("");
  const [preview, setPreview] = useState<Preview>({ status: "idle" });
  const [health, setHealth] = useState("");
  const today = useToday();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestText = useRef("");

  const locate = async (): Promise<Fix | null> => {
    setGeoState("locating");
    setGeoError(null);
    setPlace("");
    setPreview({ status: "idle" });
    try {
      const f = await getCurrentFix();
      setFix(f);
      setFixLabel(null);
      setGeoState("naming");
      try {
        const r = await previewPlace({ latitude: f.latitude, longitude: f.longitude, accuracy: f.accuracy });
        setFixLabel(r.location.name || r.location.area ? r.label : null);
      } catch {
        /* Naming is best-effort; the coordinates are still used. */
      }
      setGeoState("idle");
      return f;
    } catch (err) {
      setFix(null);
      setGeoState("error");
      setGeoError(err instanceof GeoFailure ? err.message : "Couldn't get your location. Type your city, area or postcode instead.");
      return null;
    }
  };

  const checkPlace = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    latestText.current = text;
    if (text.trim().length < 2) {
      setPreview({ status: "idle" });
      return;
    }
    timer.current = setTimeout(async () => {
      setPreview({ status: "checking" });
      try {
        const r = await previewPlace({ text: text.trim() });
        if (latestText.current === text) setPreview({ status: "found", label: r.label, accuracyNote: r.location.resolvedBy });
      } catch (err) {
        if (latestText.current !== text) return;
        if (err instanceof ApiError && err.status === 404) setPreview({ status: "notfound", message: err.message });
        else setPreview({ status: "idle" }); // offline / no token yet: the server resolves it on start
      }
    }, 600);
  };

  const typed = place.trim();
  const canStart = Boolean(fix || typed) && preview.status !== "notfound";
  const healthText = health.trim();
  const whoSentence = healthText ? ` My health context: ${healthText}.` : "";
  const currentLocation = (f: Fix | null = fix): LocationQuery | undefined =>
    typed ? { city: typed } : f ? { latitude: f.latitude, longitude: f.longitude, accuracyMeters: f.accuracy } : undefined;
  const whereSentence = (f: Fix | null = fix) =>
    typed
      ? `I'm in ${typed}${preview.status === "found" ? ` (${preview.label})` : ""}.`
      : f
        ? `I've shared my device location${fixLabel ? ` (${fixLabel})` : ""}.`
        : "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    onStart({
      message: `${whereSentence()}${whoSentence || " I haven't shared any health details yet."} Please check the air quality where I am and design an intervention to protect my health.`,
      location: currentLocation(),
      profile: profileFromChips(activeChips(health)),
    });
  };

  const startWith = async (p: (typeof STARTER_PROMPTS)[number]) => {
    let f = fix;
    if (p.useLocation && !typed && !f) {
      f = await locate();
      if (!f) return; // the location status line explains what went wrong
    }
    const where = whereSentence(f);
    onStart({
      message: `${where ? `${where} ` : ""}${p.message}${whoSentence}`,
      location: currentLocation(f),
      profile: profileFromChips(activeChips(health)),
    });
  };

  const status: { tone?: "ok" | "error"; text: string } = typed
    ? preview.status === "checking"
      ? { text: "Looking it up…" }
      : preview.status === "found"
        ? { tone: "ok", text: `Found: ${preview.label}` }
        : preview.status === "notfound"
          ? { tone: "error", text: preview.message }
          : { text: "City, area or postcode, anywhere in the world." }
    : geoState === "locating"
      ? { text: "Asking your device for a position…" }
      : geoState === "naming"
        ? { text: "Finding the name of where you are…" }
        : geoState === "error"
          ? { tone: "error", text: geoError ?? "Couldn't get your location." }
          : fix
            ? {
                tone: "ok",
                text: `${fixLabel ?? "Your shared coordinates"} · ${fix.latitude.toFixed(4)}, ${fix.longitude.toFixed(4)} · ±${fix.accuracy >= 1000 ? `${(fix.accuracy / 1000).toFixed(1)} km` : `${fix.accuracy} m`}`,
              }
            : { text: "Share your location for the nearest station, or type a place." };

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
        <div className="starters" role="group" aria-labelledby="starters-title">
          <span id="starters-title" className="kicker">
            Quick start
          </span>
          <ul className="starter-list">
            {STARTER_PROMPTS.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="starter"
                  onClick={() => void startWith(p)}
                  disabled={disabled || geoState === "locating" || geoState === "naming"}
                >
                  {p.label}
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </header>
      <div className="front-grid">
        <form className="empty-form" onSubmit={submit} aria-labelledby="start-title" aria-describedby="empty-privacy">
          <h2 id="start-title">Start your briefing</h2>
          <div className="field">
            <span id="loc-label" style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>
              Your location
            </span>
            <div className="or-row" role="group" aria-labelledby="loc-label">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void locate()}
                disabled={geoState === "locating" || geoState === "naming" || disabled}
                aria-pressed={Boolean(fix) && !typed}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
                  <circle cx="12" cy="9.5" r="2.5" />
                </svg>
                {geoState === "locating" ? "Locating…" : fix && !typed ? "Location shared ✓" : "Share my location"}
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
                onChange={(e) => {
                  setPlace(e.target.value);
                  checkPlace(e.target.value);
                }}
                aria-describedby="loc-status"
                aria-invalid={preview.status === "notfound"}
                placeholder="City, area or postcode"
                autoComplete="address-level2"
                maxLength={120}
              />
            </div>
            <span id="loc-status" className="loc-status" data-tone={status.tone} aria-live="polite">
              {status.tone === "ok" && (
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
                  <circle cx="12" cy="9.5" r="2.5" />
                </svg>
              )}
              {status.text}
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
              placeholder="Tap suggestions below or type anything relevant: age group, medications, plans for today"
              aria-describedby="health-hint"
            />
            <HealthChips text={health} onToggle={(c) => setHealth((h) => toggleChipText(h, c))} disabled={disabled} />
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
