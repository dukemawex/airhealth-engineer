import { decodeMaskToSVGPath, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import type { AppConfig } from "../config";
import { AppError, UpstreamError } from "../errors";
import { fetchWithTimeout, readJsonSafe, type FetchLike } from "../http";
import type { Logger } from "../logger";
import {
  SCENE_JSON_SCHEMA,
  SceneAnalysisSchema,
  normaliseScene,
  type OverlayRegion,
  type SceneAnalysis,
  type SceneOverlay,
} from "../vision/scene";
import type { ChatCompletionResponse } from "./types";

/**
 * Meta Model API media endpoints beyond the agent's chat loop:
 *   - Muse Spark image understanding + structured output (POST /chat/completions)
 *   - SAM 3.1 segmentation (POST /responses, stream)       https://dev.meta.ai/docs/media-segmentation
 *   - Muse Voice Transcribe (POST /asr/transcribe)          https://dev.meta.ai/docs/api-reference/voice/transcribe
 *   - Muse Image (POST /images/generations)                 https://dev.meta.ai/docs/api-reference/images
 *   - Model catalogue (GET /models) for capability checks.
 * The API key is only ever sent as a bearer header; it is never logged.
 */

export type MetaCfg = AppConfig["meta"];

export const META_MODELS = {
  vision: "muse-spark-1.3",
  segmentation: "sam-3.1",
  transcribe: "muse-voice-transcribe-1.0",
  image: "muse-image-1.0",
} as const;

export interface MediaDeps {
  cfg: MetaCfg;
  logger: Logger;
  fetchImpl?: FetchLike;
}

function key(cfg: MetaCfg): string {
  if (!cfg.apiKey) throw new AppError("config_missing", "MODEL_API_KEY is not set; Meta models are unavailable.");
  return cfg.apiKey;
}

async function fail(res: Response, service: string): Promise<never> {
  const payload = await readJsonSafe(res);
  const err = (payload as { error?: { message?: string; type?: string } } | undefined)?.error;
  throw new UpstreamError({
    service: "meta-model-api",
    status: res.status,
    message: `${service} ${res.status}: ${err?.message ?? "request failed"}`,
    retryable: [429, 500, 502, 503].includes(res.status),
    body: err ?? undefined,
  });
}

const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export function assertImageDataUrl(url: string) {
  if (!IMAGE_DATA_URL.test(url)) throw new AppError("bad_request", "image must be a base64 data: URL (jpeg, png, webp or gif)");
}

/* ------------------------------------------------------------------ */
/* Muse Spark: image understanding + json_schema                        */
/* ------------------------------------------------------------------ */

export async function analyzeScene(
  deps: MediaDeps,
  input: { imageDataUrl: string; note?: string; place?: string },
): Promise<{ analysis: SceneAnalysis; model: string; usage?: ChatCompletionResponse["usage"] }> {
  assertImageDataUrl(input.imageDataUrl);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = deps.cfg.modelId;
  const instructions = [
    "You are the vision module of AirHealth Engineer, an agent that engineers indoor air. It is not a medical service.",
    "Inspect the photo for anything that matters for indoor air quality: visible haze/smog/smoke (indoors or through windows), likely pollution sources, windows/doors/gaps, purifiers, fans/AC, vents and visible filter condition.",
    "Be honest about uncertainty: a photo cannot measure PM2.5. Say 'unclear' rather than guess.",
    "Boxes use the normalised 0-1000 grid (x right, y down). segmentTargets are short concrete noun phrases a segmentation model can outline (e.g. 'haze', 'window', 'smoke', 'air purifier', 'stove').",
    input.place ? `The user says they are in or near: ${input.place}.` : "",
    input.note ? `The user's note about the photo: ${input.note}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = {
    model,
    reasoning_effort: "medium",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instructions },
          { type: "image_url", image_url: { url: input.imageDataUrl } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "scene_analysis", strict: true, schema: SCENE_JSON_SCHEMA } },
  };
  const res = await fetchWithTimeout(
    fetchImpl,
    `${deps.cfg.baseUrl}/chat/completions`,
    { method: "POST", headers: { Authorization: `Bearer ${key(deps.cfg)}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    deps.cfg.timeoutMs,
  );
  if (!res.ok) await fail(res, "Muse Spark vision");
  const payload = (await res.json()) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content ?? "";
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    throw new UpstreamError({ service: "meta-model-api", message: "Muse Spark vision returned non-JSON output", retryable: true });
  }
  const parsed = SceneAnalysisSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new UpstreamError({ service: "meta-model-api", message: "Muse Spark vision output did not match the scene schema", retryable: true, body: parsed.error.issues.slice(0, 3) });
  }
  deps.logger.info("muse spark vision", { model, usage: payload.usage });
  return { analysis: normaliseScene(parsed.data), model, usage: payload.usage };
}

/* ------------------------------------------------------------------ */
/* SAM 3.1 segmentation                                                 */
/* ------------------------------------------------------------------ */

/** Parse an SSE body into Responses API event objects ({ type, ... }). */
export async function* readResponsesEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ type: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const ev = JSON.parse(data) as { type?: string };
        if (typeof ev.type === "string") yield ev as { type: string };
      } catch {
        /* ignore keep-alives / partial frames */
      }
    }
    if (done) break;
  }
}

export async function segmentImage(
  deps: MediaDeps,
  input: { imageDataUrl: string; phrase: string; maxRegions?: number },
): Promise<{ regions: OverlayRegion[]; width: number; height: number }> {
  assertImageDataUrl(input.imageDataUrl);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchWithTimeout(
    fetchImpl,
    `${deps.cfg.baseUrl}/responses`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key(deps.cfg)}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        model: META_MODELS.segmentation,
        stream: true,
        metadata: { mask_encoding: "one_bit" },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: input.phrase },
              { type: "input_image", image_url: input.imageDataUrl },
            ],
          },
        ],
      }),
    },
    Math.min(deps.cfg.timeoutMs, 45_000),
  );
  if (!res.ok || !res.body) await fail(res, "SAM 3.1");
  const result = await parseImageStream(readResponsesEvents(res.body!)).finalResult;
  return regionsFromSam(result.records, input.phrase, input.maxRegions ?? 6);
}

type SamRecords = Parameters<typeof recordsOfKind>[0];

/** Pair SAM box + mask records by object id into overlay regions (pixel space). */
export function regionsFromSam(records: SamRecords, label: string, maxRegions = 6) {
  const boxes = recordsOfKind(records, "box");
  const masks = new Map(recordsOfKind(records, "mask").map((m) => [m.objectId, m]));
  let width = 0;
  let height = 0;
  const regions: OverlayRegion[] = [];
  for (const b of boxes) {
    const m = masks.get(b.objectId);
    let mask: OverlayRegion["mask"];
    if (m) {
      try {
        mask = { path: decodeMaskToSVGPath(m.mask), width: m.mask.width, height: m.mask.height };
      } catch {
        mask = undefined;
      }
    }
    regions.push({
      id: `${label}-${b.objectId}`,
      label,
      box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      mask,
      confidence: b.confidence ?? m?.confidence,
    });
  }
  regions.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  for (const r of regions) {
    width = Math.max(width, r.box.right);
    height = Math.max(height, r.box.bottom);
  }
  return { regions: regions.slice(0, maxRegions), width, height };
}

/** Fallback overlay from Muse Spark's 0-1000 grounding boxes. */
export function overlayFromGrounding(a: SceneAnalysis, width: number, height: number, reason: string): SceneOverlay {
  return {
    source: "muse-spark-grounding",
    width,
    height,
    fallbackReason: reason,
    regions: a.boxes.map((b, i) => ({
      id: `box-${i}`,
      label: b.label,
      box: {
        left: Math.round((b.x_min / 1000) * width),
        top: Math.round((b.y_min / 1000) * height),
        right: Math.round((b.x_max / 1000) * width),
        bottom: Math.round((b.y_max / 1000) * height),
      },
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Muse Voice Transcribe                                                */
/* ------------------------------------------------------------------ */

export function isWav(bytes: Uint8Array): boolean {
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  return bytes.length > 44 && tag(0) === "RIFF" && tag(8) === "WAVE";
}

export async function transcribeWav(deps: MediaDeps, wav: Uint8Array): Promise<{ transcript: string; durationMs?: number; model: string }> {
  if (!isWav(wav)) throw new AppError("bad_request", "Audio must be a WAV (RIFF/WAVE) file.");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fd = new FormData();
  fd.append(
    "request",
    new Blob([JSON.stringify({ model: META_MODELS.transcribe, audioEncoding: "WAV", mode: "PUSH_TO_TALK" })], { type: "application/json" }),
  );
  fd.append("audio", new Blob([wav as BlobPart], { type: "audio/wav" }), "speech.wav");
  const res = await fetchWithTimeout(
    fetchImpl,
    `${deps.cfg.baseUrl}/asr/transcribe`,
    { method: "POST", headers: { Authorization: `Bearer ${key(deps.cfg)}`, Accept: "application/json" }, body: fd },
    Math.min(deps.cfg.timeoutMs, 30_000),
  );
  if (!res.ok) await fail(res, "Muse Voice Transcribe");
  const data = (await res.json()) as { transcript?: string; audioDurationMs?: number; turns?: Array<{ transcript?: string; text?: string }> };
  const transcript = (data.transcript ?? data.turns?.map((t) => t.transcript ?? t.text ?? "").join(" ") ?? "").trim();
  deps.logger.info("muse voice transcribe", { durationMs: data.audioDurationMs, chars: transcript.length });
  return { transcript, durationMs: data.audioDurationMs, model: META_MODELS.transcribe };
}

/* ------------------------------------------------------------------ */
/* Muse Image                                                           */
/* ------------------------------------------------------------------ */

export async function generateImage(
  deps: MediaDeps,
  prompt: string,
): Promise<{ b64: string; format: "webp" | "png" | "jpeg"; model: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchWithTimeout(
    fetchImpl,
    `${deps.cfg.baseUrl}/images/generations`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key(deps.cfg)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: META_MODELS.image,
        prompt: prompt.slice(0, 4000),
        n: 1,
        size: "1024x1024",
        reasoning_strength: "low",
        tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
      }),
    },
    Math.min(deps.cfg.timeoutMs, 90_000),
  );
  if (!res.ok) await fail(res, "Muse Image");
  const data = (await res.json()) as { data?: Array<{ b64_json?: string }>; output_format?: string };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new UpstreamError({ service: "meta-model-api", message: "Muse Image returned no image", retryable: true });
  const format = data.output_format === "png" || data.output_format === "jpeg" ? data.output_format : "webp";
  return { b64, format, model: META_MODELS.image };
}

/* ------------------------------------------------------------------ */
/* Capability check (GET /models, cached)                               */
/* ------------------------------------------------------------------ */

export interface MetaCapabilities {
  checkedAt: string;
  reachable: boolean;
  models: string[];
  features: { agent: boolean; vision: boolean; segmentation: boolean; transcribe: boolean; image: boolean };
  error?: string;
}

let capCache: { at: number; value: MetaCapabilities } | undefined;
const CAP_TTL_MS = 10 * 60_000;

export function resetCapabilityCache() {
  capCache = undefined;
}

export async function getCapabilities(deps: MediaDeps, now = Date.now()): Promise<MetaCapabilities> {
  if (capCache && now - capCache.at < CAP_TTL_MS) return capCache.value;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let value: MetaCapabilities;
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${deps.cfg.baseUrl}/models`,
      { headers: { Authorization: `Bearer ${key(deps.cfg)}` } },
      4_000,
    );
    if (!res.ok) await fail(res, "Model list");
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    const has = (id: string) => models.includes(id);
    value = {
      checkedAt: new Date(now).toISOString(),
      reachable: true,
      models,
      features: {
        agent: has(deps.cfg.modelId),
        vision: has(deps.cfg.modelId),
        segmentation: has(META_MODELS.segmentation),
        transcribe: has(META_MODELS.transcribe),
        image: has(META_MODELS.image),
      },
    };
  } catch (err) {
    value = {
      checkedAt: new Date(now).toISOString(),
      reachable: false,
      models: [],
      features: { agent: false, vision: false, segmentation: false, transcribe: false, image: false },
      error: err instanceof Error ? err.message.slice(0, 200) : "unreachable",
    };
    // Cache failures briefly so a blip does not disable features for long.
    capCache = { at: now - CAP_TTL_MS + 60_000, value };
    return value;
  }
  capCache = { at: now, value };
  return value;
}
