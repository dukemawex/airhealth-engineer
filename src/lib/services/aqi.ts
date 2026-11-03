import type { AqiCategory } from "../domain";

/**
 * PM2.5 category using the US EPA breakpoints revised in 2024 (µg/m³, 24-h basis).
 * We apply it to the latest (usually hourly) value as an indicative category and
 * say so in tool output. Source: https://www.epa.gov/aqi
 */
export function pm25Category(ugm3: number): AqiCategory {
  if (ugm3 <= 9.0) return "good";
  if (ugm3 <= 35.4) return "moderate";
  if (ugm3 <= 55.4) return "unhealthy_for_sensitive_groups";
  if (ugm3 <= 125.4) return "unhealthy";
  if (ugm3 <= 225.4) return "very_unhealthy";
  return "hazardous";
}

export const CATEGORY_RANK: Record<AqiCategory, number> = {
  good: 0,
  moderate: 1,
  unhealthy_for_sensitive_groups: 2,
  unhealthy: 3,
  very_unhealthy: 4,
  hazardous: 5,
};

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * US AQI sub-index for PM2.5 using the 2024 EPA breakpoints (linear interpolation).
 * Indicative only when applied to an hourly value (the official index is 24-h).
 */
const PM25_AQI_BREAKPOINTS: Array<[number, number, number, number]> = [
  [0.0, 9.0, 0, 50],
  [9.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

export function pm25ToUsAqi(ugm3: number): number {
  const c = Math.max(0, Math.floor(ugm3 * 10) / 10);
  for (const [cLo, cHi, iLo, iHi] of PM25_AQI_BREAKPOINTS) {
    if (c <= cHi) return Math.round(((iHi - iLo) / (cHi - cLo)) * (Math.max(c, cLo) - cLo) + iLo);
  }
  return 500;
}
