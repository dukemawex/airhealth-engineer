import { createHmac } from "node:crypto";
import type { DeviceActionResult, DeviceCommand } from "../domain";
import { UpstreamError } from "../errors";
import { fetchWithTimeout, readJsonSafe, type FetchLike } from "../http";
import { nowIso } from "../ids";
import type { DeviceState, StateStore } from "../storage";
import type { DeviceAdapter, DeviceExecutionContext } from "./types";

/**
 * Generic signed webhook adapter for any device gateway / vendor bridge.
 *   POST {DEVICE_WEBHOOK_URL}
 *   X-AirHealth-Signature: sha256=<hex HMAC-SHA256 of raw body with DEVICE_WEBHOOK_SECRET>
 *   Idempotency-Key: <approvalId>
 * The receiver should verify the signature and de-duplicate on Idempotency-Key.
 */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export class WebhookDeviceAdapter implements DeviceAdapter {
  readonly name = "webhook" as const;
  constructor(
    private readonly opts: { url: string; secret: string; timeoutMs: number; fetchImpl: FetchLike; store: StateStore },
  ) {}

  async execute(command: DeviceCommand, ctx: DeviceExecutionContext): Promise<DeviceActionResult> {
    const body = JSON.stringify({
      approvalId: ctx.approvalId,
      sessionId: ctx.sessionId,
      approvedBy: ctx.approvedBy,
      command,
      sentAt: nowIso(),
    });
    const res = await fetchWithTimeout(
      this.opts.fetchImpl,
      this.opts.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": ctx.approvalId,
          "X-AirHealth-Signature": signBody(this.opts.secret, body),
        },
        body,
      },
      this.opts.timeoutMs,
    );
    const payload = await readJsonSafe(res);
    if (!res.ok) {
      throw new UpstreamError({
        service: "device-webhook",
        status: res.status,
        message: `Device webhook failed with HTTP ${res.status}`,
        retryable: false,
        body: payload,
      });
    }
    const state: DeviceState = {
      deviceId: command.deviceId,
      deviceType: command.deviceType,
      updatedAt: nowIso(),
      lastApprovalId: ctx.approvalId,
      lastCommand: command,
      ...(payload && typeof payload === "object" && "state" in payload
        ? { reportedState: (payload as { state: unknown }).state }
        : {}),
    };
    await this.opts.store.putDeviceState(ctx.sessionId, state);
    return {
      ok: true,
      adapter: this.name,
      executedAt: nowIso(),
      message: `Webhook accepted ${command.deviceType}.${command.action} for ${command.deviceId}.`,
      deviceState: state,
      raw: payload,
    };
  }

  getStates(sessionId: string) {
    return this.opts.store.getDeviceStates(sessionId);
  }
}
