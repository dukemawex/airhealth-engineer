"use client";

import { useEffect, useRef, useState } from "react";
import type { ShareInput } from "@/lib/share/card";
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
  const canShare = typeof navigator !== "undefined" && !!file && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm share-btn" onClick={() => void open()}>
        Create “air today” card
      </button>
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
              {state.art === "muse-image" ? `Background by Muse Image (${(state.ms / 1000).toFixed(1)} s).` : "Muse Image unavailable: brand gradient used."} Numbers are drawn from your live reading. Nothing is posted until you choose.
            </p>
            <div className="share-actions">
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
