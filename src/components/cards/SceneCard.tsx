"use client";

import type { OverlayRegion, VisionResult } from "@/lib/vision/scene";
import { humanize } from "../format";

const PALETTE = ["#13b5a6", "#f2a541", "#5aa9e6", "#e86a92", "#9b7be0", "#7bc96f"];

const HAZE_TONE: Record<string, string> = { none: "ok", light: "watch", moderate: "act", heavy: "danger", unclear: "info" };

function colourFor(label: string, labels: string[]) {
  return PALETTE[Math.max(0, labels.indexOf(label)) % PALETTE.length]!;
}

function Region({ r, colour, showLabel }: { r: OverlayRegion; colour: string; showLabel: boolean }) {
  const bw = Math.max(1, r.box.right - r.box.left);
  const bh = Math.max(1, r.box.bottom - r.box.top);
  return (
    <g>
      {r.mask ? (
        <path
          d={r.mask.path}
          transform={`translate(${r.box.left} ${r.box.top}) scale(${bw / r.mask.width} ${bh / r.mask.height})`}
          fill={colour}
          fillOpacity={0.38}
          stroke={colour}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          fillRule="evenodd"
        />
      ) : (
        <rect x={r.box.left} y={r.box.top} width={bw} height={bh} fill={colour} fillOpacity={0.14} stroke={colour} strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
      )}
      {showLabel && (
        <foreignObject x={r.box.left + 4} y={r.box.top + 4} width={Math.max(60, Math.min(bw - 8, 220))} height={28}>
          <span className="scene-tag" style={{ background: colour }}>
            {r.label}
          </span>
        </foreignObject>
      )}
    </g>
  );
}

/** Compact photo + mask overlay for the studio gallery (decorative; the full card carries the details). */
export function SceneThumb({ imageUrl, result }: { imageUrl: string; result: VisionResult }) {
  const { overlay } = result;
  const labels = [...new Set(overlay.regions.map((r) => r.label))];
  return (
    <div className="scene-stage thumb-stage" style={{ aspectRatio: `${overlay.width} / ${overlay.height}` }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl} alt="" />
      <svg viewBox={`0 0 ${overlay.width} ${overlay.height}`} preserveAspectRatio="none" aria-hidden="true">
        {overlay.regions.map((r) => (
          <Region key={r.id} r={r} colour={colourFor(r.label, labels)} showLabel={false} />
        ))}
      </svg>
    </div>
  );
}

/** Photo + SAM 3.1 (or Muse Spark grounding) overlay + the structured analysis. */
export function SceneCard({ imageUrl, result, judge = false }: { imageUrl?: string; result: VisionResult; judge?: boolean }) {
  const { analysis: a, overlay } = result;
  const labels = [...new Set(overlay.regions.map((r) => r.label))];
  const sam = overlay.source === "sam-3.1";
  const firstOfLabel = new Set<string>();
  return (
    <section className="card scene-card" aria-label="Photo analysis">
      <div className="card-header">
        <div>
          <span className="kicker">
            Photo read<span className="sep" aria-hidden="true" />
            Muse Spark vision {sam ? "+ SAM 3.1" : ""}
          </span>
          <h3 className="card-title">{a.setting === "semi_open" ? "Open-sided" : humanize(a.setting)} scene</h3>
        </div>
        <span className="badge" data-tone={HAZE_TONE[a.visibleHaze]}>
          Haze: {a.visibleHaze}
        </span>
      </div>
      {imageUrl && (
        <figure className="scene-figure">
          <div className="scene-stage" style={{ aspectRatio: `${overlay.width} / ${overlay.height}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="Your photo" />
            <svg viewBox={`0 0 ${overlay.width} ${overlay.height}`} preserveAspectRatio="none" role="img" aria-label={`Outlined: ${labels.join(", ") || "nothing"}`}>
              {overlay.regions.map((r) => {
                const show = !firstOfLabel.has(r.label);
                firstOfLabel.add(r.label);
                return <Region key={r.id} r={r} colour={colourFor(r.label, labels)} showLabel={show} />;
              })}
            </svg>
          </div>
          <figcaption className="scene-caption">
            {labels.map((l) => (
              <span key={l} className="scene-legend">
                <span className="swatch" style={{ background: colourFor(l, labels) }} aria-hidden="true" />
                {l}
              </span>
            ))}
            <span className="card-sub">
              {sam
                ? `Outlines: SAM 3.1 segmentation${result.timings.segmentationMs ? ` · ${(result.timings.segmentationMs / 1000).toFixed(1)} s` : ""}`
                : `Boxes: Muse Spark grounding${overlay.fallbackReason ? ` (SAM 3.1 fallback: ${overlay.fallbackReason})` : ""}`}
            </span>
          </figcaption>
        </figure>
      )}
      <p className="card-standfirst">{a.summary}</p>
      <div className="card-section">
        <h4>What the photo suggests</h4>
        <ul className="scene-facts">
          <li>
            <strong>Haze evidence:</strong> {a.hazeEvidence}
            {a.estimatedVisibilityKm !== null && ` (visibility ~${a.estimatedVisibilityKm} km)`}
          </li>
          {a.pollutionSources.length > 0 && (
            <li>
              <strong>Possible sources:</strong> {a.pollutionSources.map((s) => `${s.name} (${humanize(s.kind)})`).join(", ")}
            </li>
          )}
          <li>
            <strong>Room:</strong> {a.room.windows} window(s), {a.room.doors} door(s) · purifier {a.room.purifierVisible ? "seen" : "not seen"} · fan/AC{" "}
            {a.room.fanOrAcVisible ? "seen" : "not seen"} · filter {humanize(a.room.filterCondition)}
          </li>
        </ul>
      </div>
      {a.engineeringNotes.length > 0 && (
        <div className="card-section">
          <h4>Engineering notes</h4>
          <ul className="scene-facts">
            {a.engineeringNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="card-sub">
        Confidence {a.confidence}. A photo is visual evidence only; it can&apos;t measure PM2.5. The image is analysed in memory and not stored.
      </p>
      {judge && (
        <details className="judge-raw">
          <summary>
            Structured output · {result.models.vision} json_schema · {(result.timings.visionMs / 1000).toFixed(1)} s
          </summary>
          <pre>{JSON.stringify(a, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

export function SceneProgress({ imageUrl, stage, error, onDismiss }: { imageUrl?: string; stage: string; error?: string; onDismiss?: () => void }) {
  return (
    <section className="card scene-card" aria-label="Photo analysis" aria-busy={!error} data-tone={error ? "error" : undefined}>
      <div className="scene-progress">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {imageUrl && <img src={imageUrl} alt="" className="scene-thumb" />}
        <div role="status">
          <strong>{error ? "Couldn't read the photo" : stage}</strong>
          <p className="card-sub">{error ?? "Muse Spark reads the scene, then SAM 3.1 outlines haze, windows and devices."}</p>
        </div>
        {error && onDismiss && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </section>
  );
}
