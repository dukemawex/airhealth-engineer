import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { MetaModelClient } from "@/lib/meta/client";


const ok = {
  id: "chatcmpl_1",
  object: "chat.completion",
  created: 1,
  model: "muse-spark-1.3",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(env: Record<string, string>, fetchImpl: typeof fetch) {
  const sleepFn = vi.fn(async () => undefined);
  const c = new MetaModelClient({
    config: parseConfig({ MODEL_API_KEY: "LLM_secret", ...env }).meta,
    logger: createLogger(),
    fetchImpl,
    sleepFn,
  });
  return { c, sleepFn };
}

const tool = { type: "function" as const, function: { name: "getStatus", description: "d", parameters: { type: "object" } } };

describe("MetaModelClient", () => {
  it("posts an OpenAI-compatible request with tool_choice auto and Bearer auth", async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, ok));
    const { c } = client({ META_REASONING_EFFORT: "low" }, fetchImpl as never);
    const res = await c.createChatCompletion({ messages: [{ role: "user", content: "x" }], tools: [tool] });
    expect(res.choices[0]!.message.content).toBe("hi");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.meta.ai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer LLM_secret");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "muse-spark-1.3", tool_choice: "auto", parallel_tool_calls: false, reasoning_effort: "low" });
  });

  it("retries 429 honoring Retry-After, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(429, { error: { message: "slow down", type: "rate_limit_error" } }, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonRes(503, { error: { message: "busy" } }))
      .mockResolvedValueOnce(jsonRes(200, ok));
    const { c, sleepFn } = client({}, fetchImpl as never);
    await c.createChatCompletion({ messages: [{ role: "user", content: "x" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect((sleepFn.mock.calls[0] as unknown as [number])[0]).toBeGreaterThanOrEqual(2000);
  });

  it("does not retry 400 or 504", async () => {
    for (const status of [400, 504]) {
      const fetchImpl = vi.fn(async () => jsonRes(status, { error: { message: "bad", type: "invalid_request_error" } }));
      const { c } = client({}, fetchImpl as never);
      await expect(c.createChatCompletion({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({
        status,
        retryable: false,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after META_MAX_RETRIES", async () => {
    const fetchImpl = vi.fn(async () => jsonRes(500, { error: { message: "boom" } }));
    const { c } = client({ META_MAX_RETRIES: "2" }, fetchImpl as never);
    await expect(c.createChatCompletion({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails fast with config_missing when no key is set", async () => {
    const fetchImpl = vi.fn();
    const c = new MetaModelClient({ config: parseConfig({}).meta, logger: createLogger(), fetchImpl: fetchImpl as never });
    await expect(c.createChatCompletion({ messages: [] })).rejects.toMatchObject({ code: "config_missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
