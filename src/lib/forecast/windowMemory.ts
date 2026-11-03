import type { StoredOutdoorWindow } from "../domain";
import { bestOutdoorWindow, type OutdoorHour, type OutdoorWindow } from "./outdoorWindow";

/** Default outing length when the user did not say (minutes). */
export const DEFAULT_OUTDOOR_MINUTES = 60;

export const locationKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

export interface WindowChange {
  previous: string;
  reasons: string[];
}

export interface ResolvedWindow {
  window: OutdoorWindow | null;
  stored: StoredOutdoorWindow;
  /** True when the window on file was reused verbatim (same forecast hour, place, length, threshold). */
  reused: boolean;
  /** Present only when a different window replaces one already quoted to the user. */
  changedFrom?: WindowChange;
}

const fmtMin = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);

/**
 * Compute the best outdoor window deterministically and keep it stable within a session:
 * same forecast hour + place + outing length + threshold => the stored window is reused as-is.
 * When any input changes and the window moves, return the reasons so the reply can say why.
 */
export function resolveOutdoorWindow(input: {
  previous?: StoredOutdoorWindow;
  hours: OutdoorHour[];
  forecastHour: string;
  locationKey: string;
  durationMinutes: number;
  thresholdPm25: number;
  now?: Date;
}): ResolvedWindow {
  const prev = input.previous;
  const same =
    prev &&
    prev.forecastHour === input.forecastHour &&
    prev.locationKey === input.locationKey &&
    prev.durationMinutes === input.durationMinutes &&
    prev.thresholdPm25 === input.thresholdPm25;
  if (prev && same) return { window: prev.window, stored: prev, reused: true };

  const window = bestOutdoorWindow(input.hours, { thresholdPm25: input.thresholdPm25, durationHours: input.durationMinutes / 60 });
  const stored: StoredOutdoorWindow = {
    forecastHour: input.forecastHour,
    locationKey: input.locationKey,
    durationMinutes: input.durationMinutes,
    thresholdPm25: input.thresholdPm25,
    computedAt: (input.now ?? new Date()).toISOString(),
    window: window ? { ...window } : null,
  };
  if (!prev || !prev.window) return { window, stored, reused: false };
  const moved = !window || window.startLocal !== prev.window.startLocal || window.endLocal !== prev.window.endLocal;
  if (!moved) {
    // Same slot: keep the earlier wording so the quoted line does not drift.
    stored.window = window && window.avgPm25 === prev.window.avgPm25 ? prev.window : stored.window;
    return { window: stored.window as OutdoorWindow | null, stored, reused: false };
  }
  const reasons: string[] = [];
  if (prev.locationKey !== input.locationKey) reasons.push("your location changed");
  if (prev.durationMinutes !== input.durationMinutes) reasons.push(`the outing length changed from ${fmtMin(prev.durationMinutes)} to ${fmtMin(input.durationMinutes)}`);
  if (prev.thresholdPm25 !== input.thresholdPm25)
    reasons.push(`your threshold changed from ${prev.thresholdPm25} to ${input.thresholdPm25} µg/m³ (sensitivity profile)`);
  if (prev.forecastHour !== input.forecastHour) reasons.push(`the forecast moved on from ${prev.forecastHour.slice(11, 16)} to ${input.forecastHour.slice(11, 16)} (new hourly data)`);
  if (!reasons.length) reasons.push("the forecast data changed");
  return { window, stored, reused: false, changedFrom: { previous: prev.window.summary, reasons } };
}
