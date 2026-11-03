"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { whatsappText, whatsappUrl, type ShareInput } from "@/lib/share/card";
import { fetchShareArt, renderShareCard } from "@/lib/client/shareCard";

type State =
  | { stage: "idle" }
  | { stage: "working" }
  | { stage: "ready"; url: string; blob: Blob; art: "muse-image" | "gradient"; ms: number }
  | { stage: "error"; message: string };

/**
 * Builds the "air today" card on demand. Sharing only happens through the
 * user's own share sheet or a download: nothing is posted automatically.
 */
export function ShareCardButton({ input }: { input: ShareInput }) {
  const [state, setState] = useState<State>({ stage: "idle" });
  const dialog = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);

  // Abort an in-flight request on unmount only.
  useEffect(() => () => abort.current?.abort(), []);
  // Free the previous preview URL whenever it is replaced.
  const previewUrl = state.stage === "ready" ? state.url : null;
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const open = async () => {
    dialog.current?.showModal();
    setState({ stage: "working" });
    abort.current = new AbortController();
    try {
      const art = await fetchShareArt(input, abort.current.signal);
      const blob = await renderShareCard(input, art.image);
      setState({ stage: "ready", url: URL.createObjectURL(blob), blob, art: art.image ? "muse-image" : "gradient", ms: art.latencyMs });
      // Add it to the studio gallery (kept in this tab only; nothing is uploaded).
      window.dispatchEvent(new CustomEvent("airhealth:card", { detail: { blob, place: input.place } }));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState({ stage: "error", message: err instanceof Error ? err.message : "Could not build the card." });
    }
  };
  const close = () => {
    abort.current?.abort();
    dialog.current?.close();
    setState({ stage: "idle" });
  };
  const file = state.stage === "ready" ? new File([state.blob], "air-today.png", { type: "image/png" }) : null;
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => undefined);
  const waText = whatsappText(input, origin);
  // Native share sheet with the image (WhatsApp shows up there on phones); falls back to a wa.me link.
  const shareToWhatsApp = async () => {
    if (file && typeof navigator.canShare === "function" && navigator.canShare({ files: [file], text: waText })) {
      try {
        await navigator.share({ files: [file], text: waText, title: `Air today · ${input.place}` });
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      }
    }
    window.open(whatsappUrl(waText), "_blank", "noopener,noreferrer");
  };
  const canShare = typeof navigator !== "undefined" && !!file && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm share-btn" onClick={() => void open()}>
        Create “air today” card
      </button>
      <a
        className="btn btn-secondary btn-sm whatsapp-btn"
        href={whatsappUrl(waText)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Share the air in ${input.place} on WhatsApp (opens WhatsApp, you choose who gets it)`}
      >
        <WhatsAppIcon /> WhatsApp
      </a>
      <dialog ref={dialog} className="share-dialog" aria-labelledby="share-title" onClose={() => setState({ stage: "idle" })}>
        <div className="share-head">
          <h2 id="share-title">Air today card</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
        {state.stage === "working" && (
          <div className="share-stage" aria-busy="true" role="status">
            <div className="skeleton share-skel" />
            <p className="card-sub">Muse Image is painting the sky over {input.place}…</p>
          </div>
        )}
        {state.stage === "error" && <p className="banner" data-tone="error">{state.message}</p>}
        {state.stage === "ready" && (
          <div className="share-stage">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={state.url} alt={`Air today card for ${input.place}`} className="share-preview" />
            <p className="card-sub">
              {state.art === "muse-image" ? `Background by Muse Image (${(state.ms / 1000).toFixed(1)} s).` : "Muse Image unavailable: brand gradient used."} Numbers are drawn from your live reading. Nothing is sent until you pick a chat and press send.
            </p>
            <div className="share-actions">
              <button type="button" className="btn btn-secondary whatsapp-btn" onClick={() => void shareToWhatsApp()}>
                <WhatsAppIcon /> Send on WhatsApp
              </button>
              <a className="btn btn-secondary" href={state.url} download="air-today.png">
                Download PNG
              </a>
              {canShare && file && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void navigator.share({ files: [file], title: `Air today · ${input.place}` }).catch(() => undefined)}
                >
                  Share…
                </button>
              )}
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}

const noopSubscribe = () => () => {};

function WhatsAppIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.4.1-.7.3-.2.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.2-.2-.2-.5-.4Z"
      />
    </svg>
  );
}
