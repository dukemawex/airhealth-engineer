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

const LOOP: Array<{ title: string; body: string; icon: ReactNode }> = [
  {
    title: "Sense",
    body: "Live station readings (or clearly labelled CAMS model data), your voice and a photo of the room.",
    icon: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  },
  {
    title: "Plan",
    body: "Muse Spark reasons over the 72-hour forecast and plans purifier, window and HVAC steps.",
    icon: (
      <>
        <path d="M4 7h10M4 12h16M4 17h7" />
        <circle cx="17" cy="7" r="2" />
        <circle cx="14" cy="17" r="2" />
      </>
    ),
  },
  {
    title: "Approve & control",
    body: "Nothing touches a device until you approve it. Then the air keeps being checked.",
    icon: (
      <>
        <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
];

/** Illustrative capability cards for the hero stage: artwork only, never data. */
const STAGE: Array<{ model: string; title: string; art: ReactNode }> = [
  {
    model: "Muse Voice",
    title: "Say where you are",
    art: (
      <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        {[10, 22, 34, 46, 58, 70, 82, 94, 106].map((x, i) => (
          <line key={x} x1={x} x2={x} y1={50 - [8, 18, 30, 14, 36, 22, 28, 12, 6][i]!} y2={50 + [8, 18, 30, 14, 36, 22, 28, 12, 6][i]!} />
        ))}
      </g>
    ),
  },
  {
    model: "SAM 3.1",
    title: "Snap the haze",
    art: (
      <g>
        <rect x="8" y="14" width="100" height="72" rx="8" fill="currentColor" opacity="0.12" />
        <path d="M14 70c14-22 28-30 44-24s30-6 44-22v56H14Z" fill="currentColor" opacity="0.35" />
        <path d="M58 28h34v30H58Z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="5 4" />
        <circle cx="30" cy="34" r="8" fill="currentColor" opacity="0.5" />
      </g>
    ),
  },
  {
    model: "Muse Spark",
    title: "Plan 72 hours",
    art: (
      <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 70 22 52l14 10 16-30 16 18 14-12 14 22 12-8" />
        <path d="M6 86h104" opacity="0.4" />
        <circle cx="52" cy="32" r="5" fill="currentColor" />
      </g>
    ),
  },
  {
    model: "Muse Image",
    title: "Share your air card",
    art: (
      <g>
        <rect x="22" y="10" width="72" height="84" rx="10" fill="currentColor" opacity="0.18" />
        <rect x="32" y="56" width="40" height="8" rx="4" fill="currentColor" opacity="0.7" />
        <rect x="32" y="70" width="28" height="6" rx="3" fill="currentColor" opacity="0.45" />
        <circle cx="58" cy="34" r="12" fill="currentColor" opacity="0.55" />
      </g>
    ),
  },
];

/** Ask the composer to open its live camera, photo picker or microphone (keeps one input pipeline). */
function composerAction(kind: "attach" | "voice" | "camera") {
  window.dispatchEvent(new CustomEvent(`airhealth:${kind}`));
}

/**
 * First-run studio screen: hero stage, template tiles and the scene form (location + optional
 * sensitivity profile). Deliberately contains no example places, readings or regional data.
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
  const whoSentence = healthText ? ` My sensitivity profile: ${healthText}.` : "";
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
      message: `${whereSentence()}${whoSentence} Please check the air where I am and engineer my indoor air: purifier, windows and ventilation to cut my exposure.`,
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
    <section className="front studio-front" aria-labelledby="empty-title">
      <div className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            Indoor-air control agent
            <span className="sep" aria-hidden="true" />
            <span className="eyebrow-date" suppressHydrationWarning>
              {today || "Live"}
            </span>
          </span>
          <h1 id="empty-title" className="display">
            Engineer <span className="grad">your indoor air</span>
          </h1>
          <p className="standfirst">
            Speak, snap your room, or share where you are. Muse Spark reads live air data and the 72-hour forecast, SAM 3.1
            outlines haze and openings in your photo, and the agent plans purifier, window and HVAC steps that run only when you
            approve them.
          </p>
          <div className="hero-ctas">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => void startWith(STARTER_PROMPTS[0]!)}
              disabled={disabled || geoState === "locating" || geoState === "naming"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
                <circle cx="12" cy="9.5" r="2.5" />
              </svg>
              {geoState === "locating" ? "Locating…" : "Check my air now"}
            </button>
            <button type="button" className="btn btn-secondary btn-lg" onClick={() => composerAction("camera")} disabled={disabled} aria-haspopup="dialog">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
                <circle cx="12" cy="13.5" r="3.5" />
              </svg>
              Snap your room
            </button>
            <button type="button" className="btn btn-secondary btn-lg" onClick={() => composerAction("voice")} disabled={disabled}>
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
              Speak
            </button>
          </div>
          <p className="hero-note">An agent that engineers your indoor air, not medical advice.</p>
        </div>
        <div className="stage" aria-hidden="true">
          <div className="stage-glow" />
          {STAGE.map((c, i) => (
            <figure className="stage-card" key={c.model} style={{ ["--i" as string]: i }}>
              <svg viewBox="0 0 116 100" className="stage-art">
                {c.art}
              </svg>
              <figcaption>
                <span className="stage-model">{c.model}</span>
                <span className="stage-title">{c.title}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>

      <div className="templates" role="group" aria-labelledby="starters-title">
        <div className="section-head">
          <h2 id="starters-title" className="section-title">
            Start from a template
          </h2>
          <span className="card-sub">One tap. The agent asks before any device moves.</span>
        </div>
        <ul className="template-grid">
          {STARTER_PROMPTS.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                className="template"
                data-tone={i % 4}
                onClick={() => void startWith(p)}
                disabled={disabled || geoState === "locating" || geoState === "naming"}
              >
                <span className="template-thumb" aria-hidden="true" />
                <span className="template-label">{p.label}</span>
                <span className="template-go" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="front-grid">
        <form className="empty-form" onSubmit={submit} aria-labelledby="start-title" aria-describedby="empty-privacy">
          <h2 id="start-title" className="section-title">
            Set the scene
          </h2>
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
                {geoState === "locating" ? "Locating…" : fix && !typed ? "Location shared ✓" : "Use my location"}
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
            <label htmlFor="health">Sensitivity profile (optional)</label>
            <textarea
              id="health"
              className="textarea"
              rows={3}
              value={health}
              onChange={(e) => setHealth(e.target.value)}
              maxLength={1500}
              placeholder="Tap suggestions below or type: age group, asthma, who shares the room, plans for today"
              aria-describedby="health-hint"
            />
            <HealthChips text={health} onToggle={(c) => setHealth((h) => toggleChipText(h, c))} disabled={disabled} />
            <span id="health-hint" className="hint">
              Only tunes device thresholds and exposure windows. Not medical advice.
            </span>
          </div>
          <div className="actions" style={{ justifyContent: "space-between" }}>
            <span id="empty-privacy" className="card-sub">
              Or just use the prompt bar below.
            </span>
            <button type="submit" className="btn btn-primary" disabled={!canStart || disabled}>
              Engineer my air
            </button>
          </div>
        </form>
        <aside aria-labelledby="method-title" className="loop-card">
          <h2 id="method-title" className="section-title">
            How the loop closes
          </h2>
          <ul className="tiles">
            {LOOP.map((t) => (
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
          <p className="front-note">Environment and device control only, not medical advice. Seek urgent care for severe symptoms.</p>
        </aside>
      </div>
    </section>
  );
}
