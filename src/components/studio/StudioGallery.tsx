"use client";

import { useEffect, useState } from "react";
import type { VisionResult } from "@/lib/vision/scene";
import { SceneThumb } from "../cards/SceneCard";

export interface GalleryScene {
  id: string;
  imageUrl: string;
  result: VisionResult;
}

interface GalleryCard {
  id: string;
  url: string;
  place: string;
}

/** Keeps the "air today" cards made in this tab as gallery tiles (object URLs, freed on unmount). */
function useSessionCards(): GalleryCard[] {
  const [cards, setCards] = useState<GalleryCard[]>([]);
  useEffect(() => {
    const urls: string[] = [];
    const onCard = (e: Event) => {
      const d = (e as CustomEvent<{ blob: Blob; place: string }>).detail;
      if (!d?.blob) return;
      const url = URL.createObjectURL(d.blob);
      urls.push(url);
      setCards((c) => [{ id: url, url, place: d.place }, ...c].slice(0, 12));
    };
    window.addEventListener("airhealth:card", onCard);
    return () => {
      window.removeEventListener("airhealth:card", onCard);
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);
  return cards;
}

/**
 * Media-first strip of this session's live results: your photos with their SAM 3.1 masks and
 * Muse Image "air today" cards. Empty until you create something; never seeded.
 */
export function StudioGallery({ scenes }: { scenes: GalleryScene[] }) {
  const cards = useSessionCards();
  if (scenes.length === 0 && cards.length === 0) return null;
  const jump = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"] .scene-card`);
    el?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };
  return (
    <section className="gallery" aria-labelledby="gallery-title">
      <div className="section-head">
        <h2 id="gallery-title" className="section-title">
          Session results
        </h2>
        <span className="card-sub">
          {scenes.length} photo{scenes.length === 1 ? "" : "s"} · {cards.length} card{cards.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="gallery-strip">
        {scenes.map((s) => (
          <li key={s.id}>
            <button type="button" className="gallery-item" onClick={() => jump(s.id)}>
              <SceneThumb imageUrl={s.imageUrl} result={s.result} />
              <span className="gallery-cap">
                <span className="chip-model">{s.result.overlay.source === "sam-3.1" ? "SAM 3.1" : "Grounding"}</span>
                {s.result.analysis.visibleHaze === "unclear" ? "Scene read" : `Haze: ${s.result.analysis.visibleHaze}`}
              </span>
            </button>
          </li>
        ))}
        {cards.map((c) => (
          <li key={c.id}>
            <a className="gallery-item" href={c.url} download="air-today.png" aria-label={`Download the air today card for ${c.place}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.url} alt="" className="gallery-card-img" />
              <span className="gallery-cap">
                <span className="chip-model">Muse Image</span>
                {c.place}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
