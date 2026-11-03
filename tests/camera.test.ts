import { describe, expect, it } from "vitest";
import nextConfig, { PERMISSIONS_POLICY } from "../next.config";
import {
  CAMERA_MESSAGES,
  cameraConstraints,
  cameraPrecheck,
  captureFileName,
  captureSize,
  classifyCameraError,
  isIOS,
  otherFacing,
  trackHasTorch,
} from "@/lib/client/camera";

const domErr = (name: string) => Object.assign(new Error(name), { name });

describe("live camera helpers", () => {
  it("prechecks secure context and getUserMedia support", () => {
    expect(cameraPrecheck({ isSecureContext: false, hasGetUserMedia: true })).toBe("insecure");
    expect(cameraPrecheck({ isSecureContext: true, hasGetUserMedia: false })).toBe("unsupported");
    expect(cameraPrecheck({ isSecureContext: true, hasGetUserMedia: true })).toBeNull();
  });

  it("maps getUserMedia errors to clear problems", () => {
    expect(classifyCameraError(domErr("NotAllowedError"))).toBe("denied");
    expect(classifyCameraError(domErr("SecurityError"))).toBe("denied");
    expect(classifyCameraError(domErr("NotFoundError"))).toBe("no-camera");
    expect(classifyCameraError(domErr("NotReadableError"))).toBe("busy");
    expect(classifyCameraError(domErr("OverconstrainedError"))).toBe("constraints");
    expect(classifyCameraError(domErr("AbortError"))).toBe("aborted");
    expect(classifyCameraError("weird")).toBe("unknown");
    for (const m of Object.values(CAMERA_MESSAGES)) {
      expect(m.title.length).toBeGreaterThan(5);
      expect(m.body.length).toBeGreaterThan(20);
    }
  });

  it("asks for the rear camera by default without hard-failing on single-camera laptops", () => {
    const c = cameraConstraints("environment");
    expect(c.audio).toBe(false);
    expect(c.video).toMatchObject({ facingMode: { ideal: "environment" } });
    expect(otherFacing("environment")).toBe("user");
    expect(otherFacing("user")).toBe("environment");
  });

  it("detects iOS including iPadOS that reports as a Mac", () => {
    expect(isIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(true);
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
    expect(isIOS("Mozilla/5.0 (Linux; Android 15)")).toBe(false);
  });

  it("caps captured frame size and names files", () => {
    expect(captureSize(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(captureSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(captureSize(0, 0)).toEqual({ width: 0, height: 0 });
    expect(captureFileName(new Date(2026, 10, 3, 7, 5, 9))).toBe("camera-20261103-070509.jpg");
  });

  it("only offers a torch when the track reports one", () => {
    expect(trackHasTorch({ torch: true })).toBe(true);
    expect(trackHasTorch({ torch: false })).toBe(false);
    expect(trackHasTorch({})).toBe(false);
    expect(trackHasTorch(undefined)).toBe(false);
  });
});

describe("Permissions-Policy", () => {
  it("allows camera and microphone on our own origin on every route", async () => {
    expect(PERMISSIONS_POLICY).toContain("camera=(self)");
    expect(PERMISSIONS_POLICY).toContain("microphone=(self)");
    expect(PERMISSIONS_POLICY).not.toMatch(/camera=\(\)/);
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all?.headers).toContainEqual({ key: "Permissions-Policy", value: PERMISSIONS_POLICY });
  });
});
