/**
 * Pure helpers for live in-app camera capture (getUserMedia). Kept free of
 * React and DOM globals so they can be unit-tested in Node.
 */

export type Facing = "environment" | "user";

export type CameraProblem = "insecure" | "unsupported" | "denied" | "no-camera" | "busy" | "constraints" | "aborted" | "unknown";

export interface CameraEnv {
  isSecureContext?: boolean;
  hasGetUserMedia: boolean;
}

/** Why the live camera can't be used before even asking, or null when it can. */
export function cameraPrecheck(env: CameraEnv): CameraProblem | null {
  if (env.isSecureContext === false) return "insecure";
  if (!env.hasGetUserMedia) return "unsupported";
  return null;
}

/** Map a getUserMedia / play() rejection to a problem code. */
export function classifyCameraError(err: unknown): CameraProblem {
  const name = typeof err === "object" && err && "name" in err ? String((err as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no-camera";
    case "NotReadableError":
    case "TrackStartError":
      return "busy";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "constraints";
    case "AbortError":
      return "aborted";
    default:
      return "unknown";
  }
}

export const CAMERA_MESSAGES: Record<CameraProblem, { title: string; body: string }> = {
  insecure: {
    title: "Camera needs a secure page",
    body: "Browsers only allow the camera over https. Open the https address of AirHealth Engineer, or upload a photo instead.",
  },
  unsupported: {
    title: "This browser can't open the camera here",
    body: "Live capture isn't available in this browser or in-app webview. Use your phone's camera app or upload a photo instead.",
  },
  denied: {
    title: "Camera permission is blocked",
    body: "Allow camera access for this site in your browser's site settings (the icon next to the address bar), then try again. On iPhone: Settings → Safari → Camera → Allow.",
  },
  "no-camera": {
    title: "No camera found",
    body: "This device doesn't report a camera. Upload a photo of your room instead.",
  },
  busy: {
    title: "The camera is in use",
    body: "Another app or tab is using the camera. Close it and try again.",
  },
  constraints: {
    title: "That camera isn't available",
    body: "The requested camera couldn't be opened. Try switching cameras.",
  },
  aborted: {
    title: "The camera stopped",
    body: "The camera was interrupted before it started. Try again.",
  },
  unknown: {
    title: "Couldn't start the camera",
    body: "Something went wrong opening the camera. Try again, or upload a photo instead.",
  },
};

/** Constraints for a facing mode. `ideal` (not `exact`) so laptops with one camera still open. */
export function cameraConstraints(facing: Facing): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
}

export function otherFacing(f: Facing): Facing {
  return f === "environment" ? "user" : "environment";
}

/** iOS Safari / any iOS WebKit (incl. iPadOS that reports as Mac with touch). */
export function isIOS(ua: string, maxTouchPoints = 0): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** Scale a frame so its longest side is at most `max` (the vision route has a size cap). */
export function captureSize(w: number, h: number, max = 1600): { width: number; height: number } {
  if (!w || !h) return { width: 0, height: 0 };
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

export function captureFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `camera-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
}

/** Whether a video track reports a controllable torch. */
export function trackHasTorch(caps: unknown): boolean {
  return typeof caps === "object" && caps !== null && "torch" in caps && Boolean((caps as { torch?: unknown }).torch);
}
