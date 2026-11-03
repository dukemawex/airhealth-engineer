import { vi } from "vitest";
import { AgentRunner } from "@/lib/agent/loop";
import { parseConfig } from "@/lib/config";
import type { DeviceAdapter } from "@/lib/devices";
import type { DeviceCommand } from "@/lib/domain";
import { createLogger } from "@/lib/logger";
import type { ChatCompletionRequest, ChatCompletionResponse, ModelClient, ToolCall } from "@/lib/meta/types";
import { MemoryStateStore } from "@/lib/storage/memory";

export type Req = Omit<ChatCompletionRequest, "model">;
type Step = ChatCompletionResponse | ((req: Req) => ChatCompletionResponse);

let callSeq = 0;
export function toolCall(name: string, args: unknown, id = `call_${++callSeq}`): ToolCall {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

export function reply(content: string | null, toolCalls?: ToolCall[]): ChatCompletionResponse {
  return {
    id: `chatcmpl_${++callSeq}`,
    object: "chat.completion",
    created: 0,
    model: "muse-spark-1.3",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
  };
}

/** Scripted stand-in for the Muse Spark model. Records every request. */
export class ScriptedModel implements ModelClient {
  readonly modelId = "muse-spark-1.3";
  readonly requests: Req[] = [];
  constructor(private readonly steps: Step[], private readonly fallback?: Step) {}
  async createChatCompletion(req: Req): Promise<ChatCompletionResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift() ?? this.fallback;
    if (!step) throw new Error("ScriptedModel ran out of steps");
    return typeof step === "function" ? step(req) : step;
  }
}

export function mockAdapter(impl?: (cmd: DeviceCommand) => Promise<void>) {
  const execute = vi.fn(async (command: DeviceCommand) => {
    if (impl) await impl(command);
    return { ok: true, adapter: "sandbox", executedAt: new Date().toISOString(), message: `did ${command.action}` };
  });
  const adapter: DeviceAdapter = { name: "sandbox", execute, getStates: async () => [] };
  return { adapter, execute };
}

export function setup(opts: {
  steps: Step[];
  fallback?: Step;
  env?: Record<string, string>;
  adapter?: DeviceAdapter;
  now?: () => Date;
}) {
  const config = parseConfig({ MODEL_API_KEY: "LLM_test", ...opts.env });
  const store = new MemoryStateStore();
  const model = new ScriptedModel(opts.steps, opts.fallback);
  const fetchImpl = vi.fn(async () => {
    throw new Error("network disabled in tests");
  });
  const runner = new AgentRunner({
    config,
    store,
    model,
    logger: createLogger({ test: true }),
    fetchImpl,
    deviceAdapter: opts.adapter,
    now: opts.now,
  });
  return { runner, store, model, config, fetchImpl };
}

export const purifierOn = {
  command: { deviceType: "air_purifier", deviceId: "fan.bedroom_purifier", action: "set_fan_speed", fanSpeedPercent: 80 },
  reason: "Outdoor PM2.5 is elevated; raise purifier speed to reach 5 ACH.",
};

export const minimalDesign = {
  title: "Bedroom clean-air plan",
  objective: "Keep bedroom PM2.5 below 9 µg/m³ overnight",
  riskSummary: "Asthma with elevated outdoor PM2.5",
  room: { floorAreaM2: 12, ceilingHeightM: 2.5 },
  filtration: { recommendedFilterClass: "HEPA_H13" },
  ventilation: {
    strategy: "seal_and_recirculate",
    schedule: [{ start: "22:00", end: "06:00", mode: "closed_recirculate", rationale: "Outdoor air is polluted" }],
  },
  monitoringPlan: { recheckIntervalMinutes: 60 },
  deviceCommands: [purifierOn.command],
};
