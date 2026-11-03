/**
 * Single source of truth for the AirHealth Engineer mark.
 * Consumed by <Logo/>, app/apple-icon.tsx, app/opengraph-image.tsx and
 * scripts/sync-logo.mts (which writes src/app/icon.svg and docs/logo/final.svg).
 * A unit test fails if icon.svg drifts from this geometry.
 *
 * Concept: two airflow streams (clean air moving through) on a deep-teal tile,
 * with a mint "+" for health. Tuned for legibility at 16 px.
 */
export const LOGO_VIEWBOX = "0 0 32 32";
export const LOGO_COLORS = {
  tileFrom: "#14b8a6",
  tileTo: "#0b6477",
  stroke: "#ffffff",
  accent: "#a7f3d0",
} as const;
export const LOGO_TILE = { width: 32, height: 32, rx: 8 } as const;
export const LOGO_STROKE_WIDTH = 3;
export const LOGO_FLOW_PATHS = [
  "M6.5 12.5H15a3 3 0 1 0-3-3",
  "M6.5 19.5H21.5a3.25 3.25 0 1 1-3.25 3.25",
] as const;
export const LOGO_PLUS_PATH = "M24 7v5M21.5 9.5h5";
export const LOGO_PLUS_STROKE_WIDTH = 2.4;

/**
 * Standalone SVG markup (used for icon.svg and docs). `squareTile` drops the
 * corner radius for platforms that apply their own mask (apple-touch-icon).
 */
export function logoSvg(opts: { squareTile?: boolean } = {}): string {
  const c = LOGO_COLORS;
  const flows = LOGO_FLOW_PATHS.map(
    (d) =>
      `<path d="${d}" fill="none" stroke="${c.stroke}" stroke-width="${LOGO_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`,
  ).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO_VIEWBOX}">` +
    `<defs><linearGradient id="ahg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.tileFrom}"/><stop offset="1" stop-color="${c.tileTo}"/></linearGradient></defs>` +
    `<rect width="${LOGO_TILE.width}" height="${LOGO_TILE.height}" rx="${opts.squareTile ? 0 : LOGO_TILE.rx}" fill="url(#ahg)"/>` +
    flows +
    `<path d="${LOGO_PLUS_PATH}" fill="none" stroke="${c.accent}" stroke-width="${LOGO_PLUS_STROKE_WIDTH}" stroke-linecap="round"/>` +
    `</svg>\n`
  );
}

/** data: URI of the mark, for ImageResponse (apple-icon / OG image). */
export function logoDataUri(opts: { squareTile?: boolean } = {}): string {
  return `data:image/svg+xml,${encodeURIComponent(logoSvg(opts))}`;
}
