import type { DeviceActionResult, DeviceCommand } from "../domain";
import { UpstreamError } from "../errors";
import { fetchWithTimeout, readJsonSafe, type FetchLike } from "../http";
import { nowIso } from "../ids";
import type { DeviceState, StateStore } from "../storage";
import type { DeviceAdapter, DeviceExecutionContext } from "./types";

/**
 * Home Assistant REST adapter.
 *   POST {HOME_ASSISTANT_URL}/api/services/{domain}/{service}
 *   Authorization: Bearer {HOME_ASSISTANT_TOKEN}   (a long-lived access token)
 * Docs: https://developers.home-assistant.io/docs/api/rest/
 *
 * deviceId must be the Home Assistant entity_id (climate.*, fan.*, cover.*, number.*).
 */
export function toHomeAssistantCall(cmd: DeviceCommand): { domain: string; service: string; data: Record<string, unknown> } {
  const entity_id = cmd.deviceId;
  switch (cmd.deviceType) {
    case "hvac":
      switch (cmd.action) {
        case "set_mode":
          return { domain: "climate", service: "set_hvac_mode", data: { entity_id, hvac_mode: cmd.mode } };
        case "set_temperature":
          return { domain: "climate", service: "set_temperature", data: { entity_id, temperature: cmd.temperatureC } };
        case "set_fan_mode":
          return { domain: "climate", service: "set_fan_mode", data: { entity_id, fan_mode: cmd.fanMode } };
        case "set_fresh_air_intake":
          // No standard climate service exists for dampers; expose the damper as a number entity.
          return { domain: "number", service: "set_value", data: { entity_id, value: cmd.freshAirPercent } };
      }
      break;
    case "air_purifier":
      switch (cmd.action) {
        case "turn_on":
          return { domain: "fan", service: "turn_on", data: { entity_id } };
        case "turn_off":
          return { domain: "fan", service: "turn_off", data: { entity_id } };
        case "set_fan_speed":
          return { domain: "fan", service: "set_percentage", data: { entity_id, percentage: cmd.fanSpeedPercent } };
        case "set_mode":
          return { domain: "fan", service: "set_preset_mode", data: { entity_id, preset_mode: cmd.mode } };
      }
      break;
    case "window":
      switch (cmd.action) {
        case "open":
          return cmd.positionPercent !== undefined
            ? { domain: "cover", service: "set_cover_position", data: { entity_id, position: cmd.positionPercent } }
            : { domain: "cover", service: "open_cover", data: { entity_id } };
        case "close":
          return { domain: "cover", service: "close_cover", data: { entity_id } };
        case "set_position":
          return { domain: "cover", service: "set_cover_position", data: { entity_id, position: cmd.positionPercent } };
      }
      break;
  }
  throw new Error(`Unsupported command ${JSON.stringify(cmd)}`);
}

export class HomeAssistantDeviceAdapter implements DeviceAdapter {
  readonly name = "homeassistant" as const;
  constructor(
    private readonly opts: { url: string; token: string; timeoutMs: number; fetchImpl: FetchLike; store: StateStore },
  ) {}

  async execute(command: DeviceCommand, ctx: DeviceExecutionContext): Promise<DeviceActionResult> {
    const call = toHomeAssistantCall(command);
    const res = await fetchWithTimeout(
      this.opts.fetchImpl,
      `${this.opts.url}/api/services/${call.domain}/${call.service}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(call.data),
      },
      this.opts.timeoutMs,
    );
    const body = await readJsonSafe(res);
    if (!res.ok) {
      // Device actuation is not retried automatically: a human approved one actuation.
      throw new UpstreamError({
        service: "home-assistant",
        status: res.status,
        message: `Home Assistant ${call.domain}.${call.service} failed with HTTP ${res.status}`,
        retryable: false,
        body,
      });
    }
    const state: DeviceState = {
      deviceId: command.deviceId,
      deviceType: command.deviceType,
      updatedAt: nowIso(),
      lastApprovalId: ctx.approvalId,
      lastCommand: command,
    };
    await this.opts.store.putDeviceState(ctx.sessionId, state);
    return {
      ok: true,
      adapter: this.name,
      executedAt: nowIso(),
      message: `Home Assistant ${call.domain}.${call.service} called for ${command.deviceId}.`,
      deviceState: state,
      raw: body,
    };
  }

  getStates(sessionId: string) {
    return this.opts.store.getDeviceStates(sessionId);
  }
}
