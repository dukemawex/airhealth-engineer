import type { DeviceActionResult, DeviceCommand } from "../domain";
import { nowIso } from "../ids";
import type { DeviceState, StateStore } from "../storage";
import type { DeviceAdapter, DeviceExecutionContext } from "./types";

/**
 * Sandbox adapter: simulates actuation and persists the resulting device state
 * in the state store (so it survives serverless invocations). Nothing physical
 * is touched. Devices appear only after the first approved command; there is
 * no pre-seeded device inventory.
 */
export class SandboxDeviceAdapter implements DeviceAdapter {
  readonly name = "sandbox" as const;
  constructor(private readonly store: StateStore) {}

  async execute(command: DeviceCommand, ctx: DeviceExecutionContext): Promise<DeviceActionResult> {
    const existing = (await this.store.getDeviceStates(ctx.sessionId)).find((d) => d.deviceId === command.deviceId);
    const next: DeviceState = {
      ...(existing ?? {}),
      deviceId: command.deviceId,
      deviceType: command.deviceType,
      updatedAt: nowIso(),
      lastApprovalId: ctx.approvalId,
    };
    switch (command.deviceType) {
      case "hvac":
        if (command.action === "set_mode") next.mode = command.mode;
        if (command.action === "set_temperature") next.targetTemperatureC = command.temperatureC;
        if (command.action === "set_fan_mode") next.fanMode = command.fanMode;
        if (command.action === "set_fresh_air_intake") next.freshAirPercent = command.freshAirPercent;
        break;
      case "air_purifier":
        if (command.action === "turn_on") next.power = "on";
        if (command.action === "turn_off") next.power = "off";
        if (command.action === "set_fan_speed") {
          next.power = command.fanSpeedPercent === 0 ? "off" : "on";
          next.fanSpeedPercent = command.fanSpeedPercent;
        }
        if (command.action === "set_mode") {
          next.power = "on";
          next.mode = command.mode;
        }
        break;
      case "window":
        if (command.action === "open") next.positionPercent = command.positionPercent ?? 100;
        if (command.action === "close") next.positionPercent = 0;
        if (command.action === "set_position") next.positionPercent = command.positionPercent;
        break;
    }
    await this.store.putDeviceState(ctx.sessionId, next);
    return {
      ok: true,
      adapter: this.name,
      executedAt: nowIso(),
      message: `SANDBOX: simulated ${command.deviceType}.${command.action} on ${command.deviceId}. No physical device was controlled.`,
      deviceState: next,
    };
  }

  getStates(sessionId: string) {
    return this.store.getDeviceStates(sessionId);
  }
}
