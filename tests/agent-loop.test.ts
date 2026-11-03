import { describe, expect, it } from "vitest";
import { trimHistory } from "@/lib/agent/loop";
import type { ChatMessage } from "@/lib/meta/types";
import { reply, setup, toolCall } from "./helpers";


describe("agent loop", () => {
  it("runs a tool, feeds the result back, and completes", async () => {
    const call = toolCall("getHealthContext", { conditions: ["asthma"], symptoms: ["wheezing"], ageGroup: "adult" });
    const { runner, model } = setup({ steps: [reply(null, [call]), reply("Here is your plan.")] });
    const s = await runner.createSession({});
    const run = await runner.sendMessage(s.id, "I have asthma and I'm wheezing");

    expect(run.status).toBe("completed");
    expect(run.reply).toBe("Here is your plan.");
    expect(run.iterations).toBe(2);
    expect(run.toolCalls).toEqual([{ id: call.id, name: "getHealthContext", outcome: "ok" }]);

    // Developer prompt first, tool definitions sent on every call.
    expect(model.requests[0]!.messages[0]!.role).toBe("developer");
    expect(model.requests[0]!.tools!.map((t) => t.function.name)).toEqual([
      "getAirQuality",
      "getHealthContext",
      "designIntervention",
      "executeDeviceAction",
      "getStatus",
    ]);
    // Second call carries assistant tool_calls followed by the matching tool message.
    const msgs = model.requests[1]!.messages;
    const assistantIdx = msgs.findIndex((m) => m.role === "assistant" && "tool_calls" in m && m.tool_calls);
    const toolMsg = msgs[assistantIdx + 1] as Extract<ChatMessage, { role: "tool" }>;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe(call.id);
    const result = JSON.parse(toolMsg.content);
    expect(result.assessment.sensitiveGroup).toBe(true);

    const saved = await runner.getSession(s.id);
    expect(saved.status).toBe("idle");
    expect(saved.profile?.conditions).toEqual(["asthma"]);
  });

  it("returns zod validation errors to the model instead of executing", async () => {
    const bad = toolCall("getHealthContext", { ageGroup: "martian" });
    const notJson = toolCall("getStatus", "{not json");
    const unknown = toolCall("launchRockets", {});
    const { runner, model } = setup({ steps: [reply(null, [bad, notJson, unknown]), reply("Sorry.")] });
    const s = await runner.createSession({});
    const run = await runner.sendMessage(s.id, "hi");

    expect(run.status).toBe("completed");
    expect(run.toolCalls.map((t) => t.outcome)).toEqual(["error", "error", "error"]);
    const tools = model.requests[1]!.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
    expect(JSON.parse(tools[0]!.content).error).toBe("Invalid arguments");
    expect(JSON.parse(tools[0]!.content).issues[0].path).toBe("ageGroup");
    expect(JSON.parse(tools[1]!.content).error).toMatch(/not valid JSON/);
    expect(JSON.parse(tools[2]!.content).error).toMatch(/Unknown tool/);
    const saved = await runner.getSession(s.id);
    expect(saved.profile).toBeUndefined();
  });

  it("stops at the max-iterations guard", async () => {
    const { runner, model } = setup({
      steps: [],
      fallback: () => reply(null, [toolCall("getStatus", {})]),
      env: { AGENT_MAX_ITERATIONS: "3" },
    });
    const s = await runner.createSession({});
    const run = await runner.sendMessage(s.id, "loop forever");
    expect(run.status).toBe("max_iterations");
    expect(model.requests).toHaveLength(3);
    expect((await runner.getSession(s.id)).status).toBe("idle");

  });

  it("stops when the run budget is exhausted", async () => {
    let t = 0;
    const now = () => new Date(1_800_000_000_000 + t);
    const { runner, model } = setup({
      steps: [],
      fallback: () => {
        t += 6_000;
        return reply(null, [toolCall("getStatus", {})]);
      },
      env: { AGENT_RUN_BUDGET_MS: "10000" },
      now,
    });
    const s = await runner.createSession({});
    const run = await runner.sendMessage(s.id, "go");
    expect(run.status).toBe("budget_exhausted");
    expect(model.requests).toHaveLength(2);
  });

  it("records model failures on the session and allows resume", async () => {
    const { runner } = setup({
      steps: [
        reply(null, [toolCall("getStatus", {})]),
        () => {
          throw new Error("upstream down");
        },
        reply("Recovered."),
      ],
    });
    const s = await runner.createSession({});
    await expect(runner.sendMessage(s.id, "status?")).rejects.toThrow("upstream down");
    const failed = await runner.getSession(s.id);
    expect(failed.status).toBe("error");
    expect(failed.lastError).toMatch(/upstream down/);
    const resumed = await runner.resume(s.id);
    expect(resumed.status).toBe("completed");
    expect(resumed.reply).toBe("Recovered.");
  });

  it("reports tool failures (e.g. no location, network errors) to the model", async () => {
    const { runner, model } = setup({
      steps: [reply(null, [toolCall("getAirQuality", { city: "Lagos" })]), reply("Could not fetch.")],
    });
    const s = await runner.createSession({});
    const run = await runner.sendMessage(s.id, "air in Lagos?");
    expect(run.toolCalls[0]!.outcome).toBe("error");
    const toolMsg = model.requests[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(JSON.parse(toolMsg.content).error).toMatch(/network disabled/);
  });

  it("trims history at a user boundary", () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: "user", content: `u${i}` });
      msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "getStatus", arguments: "{}" } }] });
      msgs.push({ role: "tool", tool_call_id: `c${i}`, content: "{}" });
    }
    const trimmed = trimHistory(msgs, 10);
    expect(trimmed[0]!.role).toBe("user");
    expect(trimmed.length).toBeLessThanOrEqual(10);
  });
});
