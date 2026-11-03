import { describe, expect, it } from "vitest";
import { totalTraces } from "@/lib/traceStats";
import type { StepTrace } from "@/lib/ui-types";
import { purifierOn, reply, setup, toolCall } from "./helpers";

describe("step traces", () => {
  it("emits one trace per Muse Spark step with usage, reasoning tokens and tool timings", async () => {
    const call = toolCall("getHealthContext", { conditions: ["asthma"], symptoms: [] });
    const first = reply(null, [call]);
    first.usage = { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, completion_tokens_details: { reasoning_tokens: 80 } };
    const { runner } = setup({ steps: [first, reply("Done.")] });
    const s = await runner.createSession({});
    const traces: StepTrace[] = [];
    await runner.sendMessage(s.id, "asthma", { onTrace: (t) => traces.push(t) });
    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({ iteration: 1, model: "muse-spark-1.3", outcome: "tool_calls", promptTokens: 900, reasoningTokens: 80 });
    expect(traces[0]!.tools).toEqual([expect.objectContaining({ id: call.id, name: "getHealthContext", status: "ok" })]);
    expect(traces[1]).toMatchObject({ iteration: 2, outcome: "answer", reasoningTokens: null, tools: [] });
    expect(totalTraces(traces)).toMatchObject({ steps: 2, reasoningTokens: 80, promptTokens: 900, toolCalls: 1, approvals: 0 });
  });

  it("marks a step that pauses for approval", async () => {
    const { runner } = setup({ steps: [reply("Turning it on.", [toolCall("executeDeviceAction", purifierOn)])] });
    const s = await runner.createSession({});
    const traces: StepTrace[] = [];
    const run = await runner.sendMessage(s.id, "purifier on", { onTrace: (t) => traces.push(t) });
    expect(run.status).toBe("awaiting_approval");
    expect(traces[0]!.outcome).toBe("awaiting_approval");
    expect(traces[0]!.tools[0]!.status).toBe("pending_approval");
    expect(totalTraces(traces).approvals).toBe(1);
  });
});
