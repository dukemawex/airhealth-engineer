/**
 * What kind of space a plan is for. Indoor-only engineering (purifier CADR / air
 * changes per hour, window schedules, HVAC) only makes sense in an enclosed room;
 * an open-sided shelter or the open air needs dispersion and position instead.
 * Pure and client-safe.
 */
export const SPACE_TYPES = ["indoor", "semi_open", "outdoor"] as const;
export type SpaceType = (typeof SPACE_TYPES)[number];

export const SPACE_LABEL: Record<SpaceType, string> = {
  indoor: "Indoor room",
  semi_open: "Open-sided space",
  outdoor: "Outdoors",
};

/** Map a photo's scene setting to a space. Window views are still indoor rooms. */
export function spaceFromSetting(setting: string | undefined | null): SpaceType | undefined {
  if (setting === "outdoor") return "outdoor";
  if (setting === "semi_open") return "semi_open";
  if (setting === "indoor" || setting === "window_view") return "indoor";
  return undefined;
}

export const isOpenSpace = (s: SpaceType | undefined): boolean => s === "outdoor" || s === "semi_open";

/** Device types that only act on an enclosed room. */
export const INDOOR_ONLY_DEVICES = ["window", "hvac", "air_purifier"] as const;

/** Why indoor sizing is skipped, shown on the plan card. */
export function notApplicableNote(s: SpaceType): string {
  return s === "outdoor"
    ? "Not applicable outdoors: a purifier can't hold a clean-air target in open air."
    : "Not applicable in an open-sided space: air moves straight through, so a purifier can't hold a clean-air target.";
}
