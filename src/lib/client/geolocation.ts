"use client";

/**
 * Browser geolocation with the failure modes spelled out, so the UI can say exactly what went
 * wrong (insecure page, permission blocked, timeout, no fix) instead of a generic error.
 */

export type GeoFailureKind = "insecure" | "unsupported" | "denied" | "timeout" | "unavailable";

export class GeoFailure extends Error {
  constructor(public readonly kind: GeoFailureKind) {
    super(GEO_MESSAGES[kind]);
  }
}

export const GEO_MESSAGES: Record<GeoFailureKind, string> = {
  insecure: "Location sharing needs a secure (https) page. Type your city, area or postcode instead.",
  unsupported: "This browser can't share location. Type your city, area or postcode instead.",
  denied:
    "Location access is blocked for this site. Allow it from the site settings next to the address bar (and in your device's location settings), or type your area.",
  timeout: "Your device took too long to find a position. Try again near a window or with Wi-Fi on, or type your area.",
  unavailable: "Your device couldn't determine a position (location services may be off). Type your area instead.",
};

export type GeoPlatform = "ios" | "android" | "other";

/** Best-effort platform sniff, only used to pick which settings path to show. */
export function detectPlatform(ua?: string, maxTouchPoints?: number): GeoPlatform {
  const u = ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const touch = maxTouchPoints ?? (typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0);
  if (/iPhone|iPad|iPod/i.test(u) || (/Macintosh/i.test(u) && touch > 1)) return "ios";
  if (/Android/i.test(u)) return "android";
  return "other";
}

const PLATFORM_HINTS: Partial<Record<GeoFailureKind, Partial<Record<GeoPlatform, string>>>> = {
  denied: {
    ios: "On iPhone/iPad: Settings → Privacy & Security → Location Services → On, then Safari Websites → While Using the App. In Safari tap aA → Website Settings → Location → Allow, then try again.",
    android: "On Android: tap the lock/tune icon next to the address → Permissions → Location → Allow, and make sure Location is on in quick settings.",
    other: "Click the icon next to the address bar → Site settings → Location → Allow, then try again.",
  },
  unavailable: {
    ios: "On iPhone/iPad: Settings → Privacy & Security → Location Services must be on (and Precise Location helps).",
    android: "On Android: turn Location on in quick settings (Google Location Accuracy helps indoors).",
  },
  timeout: {
    ios: "On iPhone/iPad, Wi-Fi on (even unconnected) gives a much faster fix indoors.",
  },
  insecure: {
    ios: "Open the https:// link of this app in Safari; iOS never shares location with plain http pages.",
  },
};

/** Failure message plus the settings path for this device (iOS, Android or desktop). */
export function geoHelp(kind: GeoFailureKind, platform: GeoPlatform = detectPlatform()): { message: string; hint: string | null } {
  return { message: GEO_MESSAGES[kind], hint: PLATFORM_HINTS[kind]?.[platform] ?? null };
}

export interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number;
}

function once(options: PositionOptions): Promise<Fix> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: +pos.coords.latitude.toFixed(5),
          longitude: +pos.coords.longitude.toFixed(5),
          accuracy: Math.round(pos.coords.accuracy),
        }),
      (err) =>
        reject(
          new GeoFailure(err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable"),
        ),
      options,
    );
  });
}

/**
 * Precise fix first (GPS/Wi-Fi, 12 s); on timeout or no fix, fall back to a coarse network fix
 * (cached up to 10 min). Permission errors are not retried.
 */
export async function getCurrentFix(): Promise<Fix> {
  if (typeof window === "undefined" || !window.isSecureContext) throw new GeoFailure("insecure");
  if (!("geolocation" in navigator)) throw new GeoFailure("unsupported");
  try {
    const p = await navigator.permissions?.query({ name: "geolocation" as PermissionName });
    if (p?.state === "denied") throw new GeoFailure("denied");
  } catch (err) {
    if (err instanceof GeoFailure) throw err;
    /* Permissions API missing (older Safari): just ask. */
  }
  try {
    return await once({ enableHighAccuracy: true, timeout: 12_000, maximumAge: 120_000 });
  } catch (err) {
    if (err instanceof GeoFailure && err.kind === "denied") throw err;
    return once({ enableHighAccuracy: false, timeout: 20_000, maximumAge: 600_000 });
  }
}
