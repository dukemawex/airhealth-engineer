import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeWav } from "@/lib/audio/wav";

beforeAll(() => {
  Object.assign(process.env, { MODEL_API_KEY: "test-key", META_API_BASE_URL: "https://api.meta.test/v1", API_AUTH_TOKEN: "" });
});
afterEach(() => vi.unstubAllGlobals());

const post = async (body: Uint8Array) => {
  const { POST } = await import("@/app/api/transcribe/route");
  const req = new NextRequest("http://localhost:3000/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: body as BodyInit });
  return POST(req, { params: Promise.resolve({}) } as never);
};

describe("POST /api/transcribe", () => {
  it("forwards a WAV to Muse Voice Transcribe as multipart and returns the transcript", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const fd = init.body as FormData;
      const meta = JSON.parse(await (fd.get("request") as Blob).text());
      expect(meta).toMatchObject({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK" });
      expect((fd.get("audio") as Blob).size).toBeGreaterThan(44);
      return new Response(JSON.stringify({ transcript: " I'm in Ikeja with asthma ", audioDurationMs: 1000 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await post(encodeWav(new Float32Array(16_000)));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.transcript).toBe("I'm in Ikeja with asthma");
    expect(data.model).toBe("muse-voice-transcribe-1.0");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.meta.test/v1/asr/transcribe");
  });

  it("rejects non-WAV audio without calling Meta", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await post(new Uint8Array(200).fill(7));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
