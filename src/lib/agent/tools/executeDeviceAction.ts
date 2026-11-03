import { z } from "zod";
import { DeviceCommandSchema } from "../../domain";
import { defineTool } from "./types";

export const executeDeviceActionSchema = z.object({
  command: DeviceCommandSchema,
  reason: z.string().trim().min(5).max(600).describe("Why this actuation helps, shown to the human approver"),
  interventionId: z.string().trim().max(80).optional().describe("Intervention this command belongs to"),
});

export const executeDeviceActionTool = defineTool({
  name: "executeDeviceAction",
  description:
    "Request control of a smart HVAC unit, air purifier, or window actuator. ALWAYS gated: the request is queued for explicit human approval and the run pauses; nothing is actuated until a human approves. You will receive the outcome (executed, failed, rejected or expired) as this tool's result. Never claim a device changed state unless the result says executed.",
  schema: executeDeviceActionSchema,
  requiresApproval: true,
  async validateForApproval(args, ctx) {
    if (args.interventionId) {
      const intervention = await ctx.store.getIntervention(args.interventionId);
      if (!intervention || intervention.sessionId !== ctx.session.id) {
        return `Unknown interventionId ${args.interventionId} for this session.`;
      }
      if (intervention.status === "cancelled" || intervention.status === "completed") {
        return `Intervention ${args.interventionId} is ${intervention.status}; create a new one.`;
      }
    }
    return null;
  },
});
