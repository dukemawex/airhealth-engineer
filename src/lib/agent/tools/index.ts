import { z } from "zod";
import type { FunctionToolDefinition } from "../../meta/types";
import { designInterventionTool } from "./designIntervention";
import { executeDeviceActionTool } from "./executeDeviceAction";
import { getAirQualityTool } from "./getAirQuality";
import { getHealthContextTool } from "./getHealthContext";
import { getStatusTool } from "./getStatus";
import type { AgentTool } from "./types";

export type { AgentTool, ToolContext } from "./types";

export const TOOLS: AgentTool[] = [
  getAirQualityTool,
  getHealthContextTool,
  designInterventionTool,
  executeDeviceActionTool,
  getStatusTool,
] as AgentTool[];

export function toolRegistry(tools: AgentTool[] = TOOLS): Map<string, AgentTool> {
  return new Map(tools.map((t) => [t.name, t]));
}

/** Convert zod schemas into the JSON-schema `function` tool format used by Chat Completions. */
export function toFunctionDefinitions(tools: AgentTool[] = TOOLS): FunctionToolDefinition[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      type: "function",
      function: { name: t.name, description: t.description, parameters: schema },
    };
  });
}
