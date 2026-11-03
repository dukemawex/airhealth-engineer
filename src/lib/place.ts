import type { ResolvedLocation } from "./domain";

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/** "Oba Akran, Ikeja, Lagos State, Nigeria" (deduplicated), or the coordinates. Safe for client bundles. */
export function formatPlace(loc: Pick<ResolvedLocation, "area" | "name" | "admin1" | "country" | "latitude" | "longitude">): string {
  const parts: string[] = [];
  for (const p of [loc.area, loc.name, loc.admin1, loc.country]) {
    if (p && !parts.some((x) => norm(x) === norm(p))) parts.push(p);
  }
  return parts.length ? parts.join(", ") : `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
}

/** Short form for headings: "Ikeja, Nigeria". */
export function shortPlace(loc: Pick<ResolvedLocation, "area" | "name" | "admin1" | "country" | "latitude" | "longitude">): string {
  const main = loc.name ?? loc.area ?? loc.admin1;
  if (!main) return formatPlace(loc);
  return loc.country && norm(loc.country) !== norm(main) ? `${main}, ${loc.country}` : main;
}
