"use client";

import { cardLines, type ShareInput } from "@/lib/share/card";
import { authHeaders } from "./api";

export const CARD_W = 1080;
export const CARD_H = 1350;

export interface ArtResult {
  image: string | null;
  model: string | null;
  latencyMs: number;
  fallback: boolean;
  reason?: string;
}

export async function fetchShareArt(input: ShareInput, signal?: AbortSignal): Promise<ArtResult> {
  try {
    const res = await fetch("/api/share", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(input),
      signal,
    });
    if (!res.ok) return { image: null, model: null, latencyMs: 0, fallback: true, reason: `HTTP ${res.status}` };
    return (await res.json()) as ArtResult;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return { image: null, model: null, latencyMs: 0, fallback: true, reason: "network error" };
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

/** Draw the card: Muse Image art (or brand gradient) + exact live numbers. Returns a PNG blob. */
export async function renderShareCard(input: ShareInput, artDataUrl: string | null): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = CARD_W;
  c.height = CARD_H;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser.");
  const L = cardLines(input);

  // Background: art cover-fit, else teal studio gradient.
  let drewArt = false;
  if (artDataUrl) {
    try {
      const img = await loadImage(artDataUrl);
      const s = Math.max(CARD_W / img.width, CARD_H / img.height);
      ctx.drawImage(img, (CARD_W - img.width * s) / 2, (CARD_H - img.height * s) / 2, img.width * s, img.height * s);
      drewArt = true;
    } catch {
      drewArt = false;
    }
  }
  if (!drewArt) {
    const g = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
    g.addColorStop(0, "#042f2e");
    g.addColorStop(0.55, "#0f766e");
    g.addColorStop(1, "#0b1120");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    const r = ctx.createRadialGradient(CARD_W * 0.75, CARD_H * 0.2, 10, CARD_W * 0.75, CARD_H * 0.2, 600);
    r.addColorStop(0, "rgba(45,212,191,0.55)");
    r.addColorStop(1, "rgba(45,212,191,0)");
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
  }
  // Legibility scrim.
  const scrim = ctx.createLinearGradient(0, CARD_H * 0.35, 0, CARD_H);
  scrim.addColorStop(0, "rgba(3,7,18,0)");
  scrim.addColorStop(1, "rgba(3,7,18,0.92)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const pad = 80;
  ctx.textBaseline = "alphabetic";
  // Brand mark
  ctx.fillStyle = "#2dd4bf";
  ctx.beginPath();
  ctx.arc(pad + 18, pad + 18, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 34px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("AirHealth Engineer", pad + 50, pad + 30);

  let y = CARD_H - 560;
  ctx.fillStyle = "#99f6e4";
  ctx.font = "600 30px system-ui, sans-serif";
  ctx.fillText(L.kicker.toUpperCase(), pad, y);
  y += 70;
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 60px system-ui, sans-serif";
  for (const line of wrap(ctx, L.place, CARD_W - pad * 2).slice(0, 2)) {
    ctx.fillText(line, pad, y);
    y += 66;
  }
  y += 120;
  ctx.font = "800 190px system-ui, sans-serif";
  ctx.fillText(L.big, pad, y);
  const bigW = ctx.measureText(L.big).width;
  ctx.font = "600 40px system-ui, sans-serif";
  ctx.fillStyle = "#5eead4";
  ctx.fillText(L.category, pad + bigW + 30, y - 90);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "500 28px system-ui, sans-serif";
  ctx.fillText(L.bigLabel, pad + bigW + 30, y - 40);
  y += 60;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "500 32px system-ui, sans-serif";
  ctx.fillText(L.pm, pad, y);
  y += 56;
  ctx.fillStyle = "#ffffff";
  ctx.font = "500 34px system-ui, sans-serif";
  for (const line of wrap(ctx, L.action, CARD_W - pad * 2)) {
    ctx.fillText(line, pad, y);
    y += 44;
  }
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = "500 24px system-ui, sans-serif";
  ctx.fillText(L.footer, pad, CARD_H - 50);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png"));
}
