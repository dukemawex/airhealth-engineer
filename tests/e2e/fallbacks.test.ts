/** Graceful degradation over HTTP: geocoder failure, OpenAQ down / no station, model fallback. */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readUiStream, startMockAirData, startMockMuseSpark, type ChatMessage } from "./mockServers";

const air: { pm25: number; geocodeFails?: boolean; openaqDown?: boolean; noStations?: boolean; modelUp?: boolean } = { pm25: 30 };
let meta: Awaited<ReturnType<typeof startMockMuseSpark>>;
let data: Awaited<ReturnType<typeof startMockAirData>>;

beforeAll(async () => {
  meta = await startMockMuseSpark((messages: ChatMessage[]) => {
    const last = messages.at(-1)!;
    if (last.role === "user") return { toolCalls: [{ name: "getAirQuality", args: { city: last.content } }] };
    // After the tool result, the model answers from whatever it got (error or data).
    return { content: `Tool said: ${last.content?.slice(0, 200)}` };
  });
  data = await startMockAirData(air);
  Object.assign(process.env, {
    MODEL_API_KEY: "LLM_fallback_key",
    META_API_BASE_URL: meta.url,
    META_MAX_RETRIES: "0",
    OPENAQ_API_KEY: "openaq-test-key",
    OPENAQ_BASE_URL: `${data.url}/openaq`,
    GEOCODING_BASE_URL: `${data.url}/geo`,
    AIR_QUALITY_MODEL_BASE_URL: `${data.url}/model`,
    UPSTASH_REDIS_REST_URL: "",
    KV_REST_API_URL: "",
    API_AUTH_TOKEN: "",
  });
  (await import("@/lib/config")).resetConfigCache();
});
afterAll(async () => {
  await meta?.close();
  await data?.close();
});

async function ask(place: string) {
  const { POST } = await import("@/app/api/agent/route");
  const res = await POST(
    new NextRequest("http://localhost/api/agent", { method: "POST", body: JSON.stringify({ message: place }), headers: { "content-type": "application/json" } }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(200);
  const chunks = await readUiStream(res);
  const out = chunks.find((c) => c.type === "tool-output-available")?.output as Record<string, unknown>;
  const run = (chunks.find((c) => c.type === "data-run") as { data: { status: string } }).data.status;
  return { out, run, chunks };
}

describe("e2e fallbacks", () => {
  it("geocoder failure becomes a tool error the model can explain; the run still completes", async () => {
    Object.assign(air, { geocodeFails: true, openaqDown: false, noStations: false, modelUp: false });
    const { out, run } = await ask("Nowhere-ville");
    expect(typeof out.error).toBe("string");
    expect(run).toBe("completed");
  });

  it("OpenAQ down falls back to clearly labelled modelled data", async () => {
    Object.assign(air, { geocodeFails: false, openaqDown: true, modelUp: true });
    const { out } = await ask("Anytown");
    expect(out.source).toBe("open-meteo-cams-model");
    expect(String(out.sourceNote)).toMatch(/MODELLED/);
  });

  it("no station in range and no model data gives an honest error, not invented numbers", async () => {
    Object.assign(air, { openaqDown: false, noStations: true, modelUp: false });
    const { out, run } = await ask("Remote place");
    expect(typeof out.error).toBe("string");
    expect(out.readings).toBeUndefined();
    expect(run).toBe("completed");
  });
});
