"use client";

import type { ResolvedLocation } from "@/lib/domain";
import { apiFetch } from "./api";

export interface PlacePreview {
  location: ResolvedLocation;
  label: string;
}

/** Ask the server how a typed place or shared coordinates resolve (GET /api/geocode). */
export function previewPlace(q: { text: string } | { latitude: number; longitude: number; accuracy?: number }): Promise<PlacePreview> {
  const sp = new URLSearchParams();
  if ("text" in q) sp.set("q", q.text);
  else {
    sp.set("lat", String(q.latitude));
    sp.set("lon", String(q.longitude));
    if (q.accuracy !== undefined) sp.set("accuracy", String(q.accuracy));
  }
  return apiFetch<PlacePreview>(`/api/geocode?${sp}`);
}
