import type { DeviceActionResult, DeviceCommand } from "../domain";
import type { DeviceState } from "../storage";

export interface DeviceExecutionContext {
  sessionId: string;
  approvalId: string;
  approvedBy?: string;
}

/**
 * A device adapter turns an APPROVED DeviceCommand into a real (or simulated)
 * actuation. The agent loop never calls an adapter directly from a tool call:
 * only the approval endpoint does, after a human decision.
 */
export interface DeviceAdapter {
  readonly name: "sandbox" | "homeassistant" | "webhook";
  execute(command: DeviceCommand, ctx: DeviceExecutionContext): Promise<DeviceActionResult>;
  /** Last known device states for status reporting (may be empty for remote adapters). */
  getStates(sessionId: string): Promise<DeviceState[]>;
}
