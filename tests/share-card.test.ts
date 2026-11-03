import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cardLines, sharePrompt, ShareInputSchema } from "@/lib/share/card";

const input = ShareInputSchema.parse({ place: "Ikeja, Lagos, Nigeria", pm25: 41.2, aqi: 115, category: "unhealthy_for_sensitive_groups", measured: false });

describe("air today card", () => {
  it("asks Muse Image for text-free art matched to the category", () => {
    const p = sharePrompt(input);
    expect(p).toContain("Ikeja");
    expect(p).toMatch(/amber haze/);
    expect(p).toMatch(/no text/i);
  });

  it("draws exact live numbers and the non-medical framing", () => {
    const l = cardLines(input, new Date("2026-11-03T10:00:00Z"));
    expect(l.big).toBe("115");
    expect(l.pm).toContain("41.2");
    expect(l.pm).toContain("modelled (CAMS)");
    expect(l.footer).toMatch(/not medical advice/);
    expect(cardLines({ ...input, aqi: null, pm25: null, category: null }).big).toBe("—");
  });
});

describe("/api/share", () => {
  afterEach(() => vi.unstubAllGlobals());
  const call = async () => {
    Object.assign(process.env, { MODEL_API_KEY: "test-key", META_API_BASE_URL: "https://api.meta.test/v1", API_AUTH_TOKEN: "" });
    const { POST } = await import("@/app/api/share/route");
    return POST(new NextRequest("http://x/api/share", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } }), { params: Promise.resolve({}) } as never);
  };

  it("returns Muse Image art", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "UklGRg==" }], output_format: "webp" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const res = await call();
    const body = await res.json();
    expect(body.fallback).toBe(false);
    expect(body.image).toMatch(/^data:image\/webp;base64,/);
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("/images/generations");
  });

  it("falls back cleanly when Muse Image fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const body = await (await call()).json();
    expect(body).toMatchObject({ image: null, fallback: true });
  });
});
