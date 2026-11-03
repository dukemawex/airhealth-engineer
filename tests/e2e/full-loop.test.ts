/**
 * End-to-end: real route handlers + real AgentRunner + real MetaModelClient,
 * talking HTTP to a scripted Muse Spark double and mocked air-data services.
 * Flow: message -> getAirQuality + getHealthContext -> designIntervention ->
 * executeDeviceAction (approval pause) -> approve -> sandbox execute -> status -> monitoring.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { minimalDesign, purifierOn } from "../helpers";
import { readUiStream, startMockAirData, startMockMuseSpark, type ChatMessage, type ScriptReply } from "./mockServers";

const TEST_PROMPT = "I'm in Lagos with asthma, the air feels bad today.";
const air = { pm25: 42 };
let meta: Awaited<ReturnType<typeof startMockMuseSpark>>;
let data: Awaited<ReturnType<typeof startMockAirData>>;
let metaOverride: ScriptReply | null = null;

function lastAssistantToolNames(messages: ChatMessage[]): string[] {
  const a = [...messages].reverse().find((m) => m.role === "assistant" && m.tool_calls?.length);
  return a?.tool_calls?.map((t) => t.function.name) ?? [];
}

function museSparkScript(messages: ChatMessage[]): ScriptReply {
  if (metaOverride) return metaOverride;
  const first = messages[0]?.content ?? "";
  if (first.includes("worth interrupting")) {
    const payload = JSON.parse(messages[1]!.content!) as { previous: { pm25?: number } | null; current: { pm25?: number } };
    return {
      content: JSON.stringify({
        notify: true,
        severity: "act",
        message: `PM2.5 rose from ${payload.previous?.pm25} to ${payload.current.pm25} µg/m³; keep windows closed.`,
      }),
    };
  }
  const last = messages.at(-1)!;
  if (last.role === "user") {
    // The model extracts place + condition from the user's own words.
    const place = /I'm in ([^,]+?) with/.exec(last.content ?? "")?.[1];
    return {
      toolCalls: [
        { name: "getAirQuality", args: { city: place } },
        { name: "getHealthContext", args: { conditions: ["asthma"], symptoms: [] } },
      ],
    };
  }
  const names = lastAssistantToolNames(messages);
  if (names.includes("getAirQuality")) return { toolCalls: [{ name: "designIntervention", args: minimalDesign }] };
  if (names.includes("designIntervention")) {
    return {
      content: "PM2.5 is elevated for someone with asthma, so I designed a sealed, filtered bedroom plan. ",
      toolCalls: [{ name: "executeDeviceAction", args: purifierOn }],
    };
  }
  if (names.includes("executeDeviceAction")) return { content: "Your purifier is running at 80%. I'll keep monitoring." };
  return { content: "Okay." };
}

function req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const ctx = <P,>(params: P) => ({ params: Promise.resolve(params) });

beforeAll(async () => {
  meta = await startMockMuseSpark(museSparkScript);
  data = await startMockAirData(air);
  Object.assign(process.env, {
    MODEL_API_KEY: "LLM_e2e_test_key",
    META_API_BASE_URL: meta.url,
    META_MODEL_ID: "muse-spark-1.3",
    META_MAX_RETRIES: "0",
    OPENAQ_API_KEY: "openaq-test-key",
    OPENAQ_BASE_URL: `${data.url}/openaq`,
    GEOCODING_BASE_URL: `${data.url}/geo`,
    AIR_QUALITY_MODEL_BASE_URL: `${data.url}/model`,
    DEVICE_ADAPTER: "sandbox",
    CRON_SECRET: "cron-e2e-secret",
    MONITOR_MIN_INTERVAL_MINUTES: "1",
    UPSTASH_REDIS_REST_URL: "",
    KV_REST_API_URL: "",
    API_AUTH_TOKEN: "",
  });
  const { resetConfigCache } = await import("@/lib/config");
  resetConfigCache();
});

afterAll(async () => {
  await meta?.close();
  await data?.close();
});

describe("e2e: autonomous loop over HTTP with a scripted Muse Spark", () => {
  let conversationId = "";
  let approvalId = "";

  it("health reports configuration without leaking secrets", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(req("/api/health"), ctx({}));
    const text = await res.text();
    expect(text).not.toContain("LLM_e2e_test_key");
    expect(text).not.toContain("openaq-test-key");
    expect(text).not.toContain("cron-e2e-secret");
    const body = JSON.parse(text);
    expect(body.checks.metaModelApi.configured).toBe(true);
  });

  it("streams geocode -> air quality -> health -> plan, then pauses for approval", async () => {
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(req("/api/agent", { method: "POST", body: { message: TEST_PROMPT } }), ctx({}));
    expect(res.status).toBe(200);
    conversationId = res.headers.get("x-conversation-id") ?? "";
    expect(conversationId).toBeTruthy();
    const chunks = await readUiStream(res);

    const types = chunks.map((c) => c.type);
    expect(types[0]).toBe("start");
    expect(types.at(-1)).toBe("finish");
    const outputs = chunks.filter((c) => c.type === "tool-output-available");
    const inputs = chunks.filter((c) => c.type === "tool-input-available").map((c) => c.toolName);
    expect(inputs).toEqual(["getAirQuality", "getHealthContext", "designIntervention", "executeDeviceAction"]);

    const aq = outputs[0]!.output as { source: string; readings: Array<{ parameter: string; value: number }>; location: { name: string } };
    expect(aq.source).toBe("openaq");
    expect(aq.location.name).toBe("Lagos"); // came from the message via the geocoder, not app code
    expect(aq.readings.find((r) => r.parameter === "pm25")?.value).toBe(42);

    const approval = chunks.find((c) => c.type === "data-approval") as { data: { id: string; status: string } } | undefined;
    expect(approval?.data.status).toBe("pending");
    approvalId = approval!.data.id;
    const run = chunks.find((c) => c.type === "data-run") as { data: { status: string } };
    expect(run.data.status).toBe("awaiting_approval");
    expect(chunks.some((c) => c.type === "text-delta" && String(c.delta).length > 0)).toBe(true);

    // Wire format sent to the Meta Model API.
    const first = meta.requests[0]!;
    expect(first.path).toBe("/chat/completions");
    expect(first.headers.authorization).toBe("Bearer LLM_e2e_test_key");
    expect(first.body?.model).toBe("muse-spark-1.3");
    expect(first.body?.stream).toBe(true);
    const tools = first.body?.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools.every((t) => t.type === "function")).toBe(true);
    expect(tools.map((t) => t.function.name).sort()).toEqual(
      ["designIntervention", "executeDeviceAction", "getAirQuality", "getHealthContext", "getStatus"].sort(),
    );
    // Each tool result answers its call id.
    const toolMsgs = (meta.requests[1]!.body!.messages as ChatMessage[]).filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(data.requests.some((r) => r.path.startsWith("/geo/search?name=Lagos"))).toBe(true);
  });

  it("refuses a new message while the approval is pending", async () => {
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(req("/api/agent", { method: "POST", body: { conversationId, message: "hello?" } }), ctx({}));
    expect(res.status).toBe(409);
  });

  it("status shows a pending approval and the combined level", async () => {
    const { GET } = await import("@/app/api/sessions/[sessionId]/status/route");
    const res = await GET(req(`/api/sessions/${conversationId}/status`), ctx({ sessionId: conversationId }));
    const status = await res.json();
    expect(status.pendingApprovals).toHaveLength(1);
    expect(status.interventions).toHaveLength(1);
    expect(status.combined.level).not.toBe("ok");
  });

  it("approve (streamed) executes in the sandbox and resumes the conversation", async () => {
    const before = meta.requests.length;
    const { POST } = await import("@/app/api/approvals/[approvalId]/approve/route");
    const res = await POST(
      req(`/api/approvals/${approvalId}/approve?stream=ui`, { method: "POST", body: { decidedBy: "e2e" } }),
      ctx({ approvalId }),
    );
    expect(res.status).toBe(200);
    const chunks = await readUiStream(res);
    const decided = chunks.filter((c) => c.type === "data-approval").at(-1) as { data: { status: string } };
    expect(decided.data.status).toBe("executed");
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
    expect(text).toContain("purifier is running");
    expect(meta.requests.length).toBe(before + 1);
    const toolMsg = (meta.requests.at(-1)!.body!.messages as ChatMessage[]).at(-1)!;
    expect(toolMsg.role).toBe("tool");
    expect(JSON.parse(toolMsg.content!).status).toBe("executed");
  });

  it("a second decision on the same approval is rejected", async () => {
    const { POST } = await import("@/app/api/approvals/[approvalId]/reject/route");
    const res = await POST(req(`/api/approvals/${approvalId}/reject?stream=ui`, { method: "POST", body: {} }), ctx({ approvalId }));
    expect(res.status).toBe(409);
  });

  it("restores the conversation as UI messages with the executed device action", async () => {
    const { GET } = await import("@/app/api/agent/route");
    const res = await GET(req(`/api/agent?conversationId=${conversationId}`), ctx({}));
    const body = await res.json();
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].parts[0].text).toBe(TEST_PROMPT);
    const parts = body.messages.flatMap((m: { parts: Array<{ type: string; data?: { status: string } }> }) => m.parts);
    expect(parts.find((p: { type: string }) => p.type === "data-approval")?.data?.status).toBe("executed");
    expect(body.status.recentDeviceActions[0].status).toBe("executed");
    expect(body.status.monitoring.enabled).toBe(true);
  });

  it("monitoring re-check: Muse Spark decides a significant rise is worth telling the user", async () => {
    air.pm25 = 88;
    const { POST } = await import("@/app/api/sessions/[sessionId]/monitor/route");
    const res = await POST(
      req(`/api/sessions/${conversationId}/monitor`, { method: "POST", body: { force: true } }),
      ctx({ sessionId: conversationId }),
    );
    const result = await res.json();
    expect(result.checked).toBe(true);
    expect(result.notified).toBe(true);
    expect(result.decision.message).toContain("88");

    const { GET } = await import("@/app/api/agent/route");
    const conv = await (await GET(req(`/api/agent?conversationId=${conversationId}`), ctx({}))).json();
    const lastText = conv.messages.at(-1).parts.find((p: { type: string }) => p.type === "text").text as string;
    expect(lastText.startsWith("**Monitoring update**")).toBe(true);
  });

  it("cron route requires CRON_SECRET and checks monitored sessions", async () => {
    const { GET } = await import("@/app/api/cron/monitor/route");
    expect((await GET(req("/api/cron/monitor"), ctx({}))).status).toBe(401);
    const ok = await GET(req("/api/cron/monitor", { headers: { authorization: "Bearer cron-e2e-secret" } }), ctx({}));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.results.some((r: { sessionId: string }) => r.sessionId === conversationId)).toBe(true);
  });

  it("degrades gracefully: Meta 429 becomes a retryable notice, not a crash", async () => {
    const { POST } = await import("@/app/api/agent/route");
    metaOverride = { status: 429, error: { type: "rate_limit_error", message: "slow down" }, headers: { "retry-after": "0" } };
    try {
      const res = await POST(req("/api/agent", { method: "POST", body: { conversationId, message: "Any change?" } }), ctx({}));
      const chunks = await readUiStream(res);
      const notice = chunks.find((c) => c.type === "data-notice") as { data: { code: string; retryable: boolean } };
      expect(notice.data.retryable).toBe(true);
      expect((chunks.find((c) => c.type === "data-run") as { data: { status: string } }).data.status).toBe("failed");
    } finally {
      metaOverride = null;
    }
    // Retry by resuming the stored user turn.
    const res = await POST(req("/api/agent", { method: "POST", body: { conversationId, resume: true } }), ctx({}));
    const chunks = await readUiStream(res);
    expect(chunks.some((c) => c.type === "tool-input-available" && c.toolName === "getAirQuality")).toBe(true);
  });
});
