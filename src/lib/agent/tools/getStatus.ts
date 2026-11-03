import { z } from "zod";
import { buildStatusReport } from "../status";
import { defineTool } from "./types";

export const getStatusSchema = z.object({
  includeHistory: z.boolean().default(false).describe("Include completed/cancelled interventions and decided approvals"),
});

export const getStatusTool = defineTool({
  name: "getStatus",
  description:
    "Get current monitoring state for this session: location, latest air-quality snapshot and its age, health profile summary, proposed/active interventions, pending approvals, recent device actions and device states.",
  schema: getStatusSchema,
  requiresApproval: false,
  async execute(args, ctx) {
    let deviceAdapter;
    try {
      deviceAdapter = ctx.getDeviceAdapter();
    } catch {
      deviceAdapter = undefined;
    }
    return buildStatusReport(ctx.session, ctx.store, deviceAdapter, args.includeHistory);
  },
});
