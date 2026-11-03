"use client";

import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "@/lib/client/api";
import type { NewsDigest } from "@/lib/services/news";

function ago(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

type Load = { key: string; digest?: NewsDigest; error?: string };

/** "News & talks": server-fetched RSS (see /api/news). Every item links to its original. */
export function NewsPanel({ place }: { place?: string }) {
  const key = place ?? "";
  const [load, setLoad] = useState<Load | null>(null);
  const [tab, setTab] = useState<string>("local");

  useEffect(() => {
    let cancelled = false;
    const q = key ? `?place=${encodeURIComponent(key)}` : "";
    apiFetch<NewsDigest>(`/api/news${q}`)
      .then((digest) => !cancelled && setLoad({ key, digest }))
      .catch((err) => {
        if (cancelled) return;
        setLoad({ key, error: err instanceof ApiError && err.status === 401 ? "Add your access token to load news." : "News is unavailable right now." });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const current = load?.key === key ? load : null;
  if (!current) {
    return (
      <div className="panel" aria-busy="true" aria-label="Loading news">
        <div className="skeleton" />
        <div className="skeleton" style={{ width: "80%" }} />
        <div className="skeleton" style={{ width: "60%" }} />
      </div>
    );
  }
  if (current.error || !current.digest) return <p className="sidebar-empty">{current.error}</p>;

  const sections = current.digest.sections.filter((s) => s.id !== "local" || key);
  const active = sections.find((s) => s.id === tab) ?? sections[0]!;
  return (
    <div className="news">
      <div className="news-tabs" role="tablist" aria-label="News sections">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`news-tab-${s.id}`}
            aria-selected={s.id === active.id}
            aria-controls="news-tabpanel"
            tabIndex={s.id === active.id ? 0 : -1}
            className="news-tab"
            onClick={() => setTab(s.id)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const i = sections.findIndex((x) => x.id === active.id);
              const next = sections[(i + (e.key === "ArrowRight" ? 1 : sections.length - 1)) % sections.length]!;
              setTab(next.id);
              document.getElementById(`news-tab-${next.id}`)?.focus();
            }}
          >
            {s.id === "local" ? "Near you" : s.id === "global" ? "World" : s.id === "talks" ? "Talks" : "Meta"}
            {s.items.length > 0 && <span className="news-count">{s.items.length}</span>}
          </button>
        ))}
      </div>
      <div id="news-tabpanel" role="tabpanel" aria-labelledby={`news-tab-${active.id}`} className="news-panel">
        <p className="news-kicker">{active.title}</p>
        {active.items.length === 0 ? (
          <p className="sidebar-empty">{active.note}</p>
        ) : (
          <ol className="news-list">
            {active.items.map((i) => (
              <li key={i.url}>
                <a href={i.url} target="_blank" rel="noopener noreferrer" className="news-link">
                  {i.title}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <span className="news-meta">
                  <span className="news-source">{i.source}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={i.publishedAt} title={new Date(i.publishedAt).toLocaleString()} suppressHydrationWarning>
                    {ago(i.publishedAt)}
                  </time>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="card-sub news-credit">Headlines via Google News and Meta&apos;s own feeds. Refreshed every 30 minutes.</p>
      </div>
    </div>
  );
}
