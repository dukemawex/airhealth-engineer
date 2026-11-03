import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@/lib/logger";
import {
  analyzeScene,
  generateImage,
  getCapabilities,
  isWav,
  overlayFromGrounding,
  resetCapabilityCache,
  segmentImage,
  transcribeWav,
} from "@/lib/meta/media";
import { chooseSegmentTargets, runVisionPipeline } from "@/lib/vision/pipeline";
import { SCENE_JSON_SCHEMA, describeSceneForAgent, normaliseScene, type SceneAnalysis } from "@/lib/vision/scene";

const cfg = { apiKey: "test-key", baseUrl: "https://api.meta.test/v1", modelId: "muse-spark-1.3", timeoutMs: 5000, maxRetries: 0 } as never;
const logger = createLogger();
const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

const scene = (over: Partial<SceneAnalysis> = {}): SceneAnalysis => ({
  summary: "Living room with a window onto a hazy street.",
  setting: "indoor",
  visibleHaze: "moderate",
  hazeEvidence: "Skyline washed out and grey-brown.",
  estimatedVisibilityKm: 3,
  pollutionSources: [{ name: "street traffic", kind: "traffic", note: "busy road below" }],
  room: { windows: 2, doors: 1, purifierVisible: false, fanOrAcVisible: true, ventsVisible: false, filterCondition: "not_visible", estimatedFloorAreaM2: 18 },
  engineeringNotes: ["Seal the gap under the window frame."],
  segmentTargets: ["haze", "window"],
  boxes: [{ label: "window", x_min: 100, y_min: 50, x_max: 600, y_max: 700 }],
  confidence: "medium",
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
const MODELS = { data: ["muse-spark-1.3", "sam-3.1", "muse-voice-transcribe-1.0", "muse-image-1.0"].map((id) => ({ id })) };

beforeEach(() => resetCapabilityCache());

describe("scene schema", () => {
  it("is a strict json_schema: every object closed with all keys required", () => {
    const walk = (node: Record<string, unknown>) => {
      if (node.type === "object") {
        expect(node.additionalProperties).toBe(false);
        expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(node.properties as object)));
        Object.values(node.properties as Record<string, Record<string, unknown>>).forEach(walk);
      }
      if (node.type === "array") walk(node.items as Record<string, unknown>);
    };
    walk(SCENE_JSON_SCHEMA);
  });

  it("normalises boxes onto the 0-1000 grid and cleans segment targets", () => {
    const n = normaliseScene(
      scene({
        boxes: [
          { label: "a", x_min: 900, y_min: -20, x_max: 100, y_max: 1400 },
          { label: "tiny", x_min: 10, y_min: 10, x_max: 11, y_max: 11 },
        ],
        segmentTargets: ["Haze", "haze", "<script>", "window"],
      }),
    );
    expect(n.boxes).toEqual([{ label: "a", x_min: 100, y_min: 0, x_max: 900, y_max: 1000 }]);
    expect(n.segmentTargets).toEqual(["haze", "window"]);
  });

  it("describes the scene for the agent without medical claims and with the PM2.5 caveat", () => {
    const text = describeSceneForAgent(scene(), { source: "sam-3.1", labels: ["haze", "window"] });
    expect(text).toContain("Visible haze: moderate");
    expect(text).toContain("SAM 3.1");
    expect(text).toMatch(/cannot measure PM2\.5/);
  });

  it("chooses SAM targets from the analysis", () => {
    expect(chooseSegmentTargets(scene({ segmentTargets: [] }))).toEqual(["haze", "window"]);
    expect(chooseSegmentTargets(scene({ visibleHaze: "none", segmentTargets: [], room: { ...scene().room, windows: 0, purifierVisible: true } }))).toEqual(["air purifier"]);
  });
});

describe("Muse Spark vision", () => {
  it("sends the image as a content part with a strict json_schema and parses the result", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("muse-spark-1.3");
      expect(body.response_format.type).toBe("json_schema");
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: IMG } });
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return json({ id: "x", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(scene()) } }] });
    });
    const { analysis } = await analyzeScene({ cfg, logger, fetchImpl }, { imageDataUrl: IMG, place: "Ikeja" });
    expect(analysis.visibleHaze).toBe("moderate");
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.meta.test/v1/chat/completions");
  });

  it("rejects non-image data and schema-violating output", async () => {
    await expect(analyzeScene({ cfg, logger, fetchImpl: vi.fn() }, { imageDataUrl: "https://example.com/x.jpg" })).rejects.toThrow(/data: URL/);
    const bad = vi.fn(async () => json({ choices: [{ message: { content: JSON.stringify({ summary: 1 }) } }] }));
    await expect(analyzeScene({ cfg, logger, fetchImpl: bad }, { imageDataUrl: IMG })).rejects.toThrow(/scene schema/);
  });
});

describe("SAM 3.1 segmentation", () => {
  const fixture = readFileSync(new URL("./fixtures/sam-sky.sse", import.meta.url), "utf8");

  it("parses a real SAM 3.1 stream into box + mask regions", async () => {
    const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("sam-3.1");
      expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "sky" });
      expect((init?.headers as Record<string, string>).Accept).toBe("text/event-stream");
      return sse(fixture);
    });
    const { regions } = await segmentImage({ cfg, logger, fetchImpl }, { imageDataUrl: IMG, phrase: "sky" });
    expect(regions.length).toBeGreaterThan(0);
    expect(regions[0]!.box).toEqual({ left: 0, top: 6, right: 640, bottom: 354 });
    expect(regions[0]!.mask?.path).toMatch(/^M/);
    expect(regions[0]!.mask?.width).toBe(640);
  });

  it("falls back to Muse Spark grounding boxes when SAM fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/models")) return json(MODELS);
      if (u.endsWith("/chat/completions")) return json({ choices: [{ message: { content: JSON.stringify(scene()) } }] });
      return json({ error: { message: "overloaded" } }, 503);
    });
    const r = await runVisionPipeline({ cfg, logger, fetchImpl }, { imageDataUrl: IMG, width: 1000, height: 500 });
    expect(r.overlay.source).toBe("muse-spark-grounding");
    expect(r.overlay.fallbackReason).toMatch(/sam-3.1 failed/);
    expect(r.overlay.regions[0]!.box).toEqual({ left: 100, top: 25, right: 600, bottom: 350 });
    expect(r.models.segmentation).toBeNull();
  });

  it("uses SAM outlines when available", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/models")) return json(MODELS);
      if (u.endsWith("/chat/completions")) return json({ choices: [{ message: { content: JSON.stringify(scene({ segmentTargets: ["sky"], visibleHaze: "none", room: { ...scene().room, windows: 0 } })) } }] });
      return sse(fixture);
    });
    const r = await runVisionPipeline({ cfg, logger, fetchImpl }, { imageDataUrl: IMG, width: 640, height: 480 });
    expect(r.overlay.source).toBe("sam-3.1");
    expect(r.models.segmentation).toBe("sam-3.1");
  });

  it("maps grounding boxes into pixel space", () => {
    const o = overlayFromGrounding(scene(), 200, 100, "x");
    expect(o.regions[0]!.box).toEqual({ left: 20, top: 5, right: 120, bottom: 70 });
  });
});

describe("Muse Voice Transcribe + Muse Image + capabilities", () => {
  const wav = () => {
    const b = new Uint8Array(64);
    b.set([82, 73, 70, 70], 0);
    b.set([87, 65, 86, 69], 8);
    return b;
  };

  it("posts multipart WAV with the documented request part", async () => {
    expect(isWav(wav())).toBe(true);
    expect(isWav(new Uint8Array(64))).toBe(false);
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.meta.test/v1/asr/transcribe");
      const fd = init?.body as FormData;
      expect(JSON.parse(await (fd.get("request") as Blob).text())).toEqual({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK" });
      expect(fd.get("audio")).toBeInstanceOf(Blob);
      return json({ sessionId: "s", transcript: " I'm in Ikeja with asthma ", audioDurationMs: 2100, turns: [] });
    });
    const r = await transcribeWav({ cfg, logger, fetchImpl }, wav());
    expect(r.transcript).toBe("I'm in Ikeja with asthma");
    await expect(transcribeWav({ cfg, logger, fetchImpl }, new Uint8Array(10))).rejects.toThrow(/WAV/);
  });

  it("generates an image with tools disabled", async () => {
    const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("muse-image-1.0");
      expect(body.tool_enablement).toEqual({ enable_image_search: false, enable_web_search: false, enable_shell: false });
      return json({ created: 1, data: [{ b64_json: "UklGRg==" }] });
    });
    const r = await generateImage({ cfg, logger, fetchImpl }, "teal skyline");
    expect(r.b64).toBe("UklGRg==");
  });

  it("derives capabilities from /models and degrades when unreachable", async () => {
    const ok = await getCapabilities({ cfg, logger, fetchImpl: vi.fn(async () => json({ data: [{ id: "muse-spark-1.3" }] })) });
    expect(ok.features).toEqual({ agent: true, vision: true, segmentation: false, transcribe: false, image: false });
    resetCapabilityCache();
    const down = await getCapabilities({ cfg, logger, fetchImpl: vi.fn(async () => json({}, 500)) });
    expect(down.reachable).toBe(false);
    expect(down.features.vision).toBe(false);
  });
});
