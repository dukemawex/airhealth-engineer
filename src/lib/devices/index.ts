import type { AppConfig } from "../config";
import { AppError } from "../errors";
import type { FetchLike } from "../http";
import type { StateStore } from "../storage";
import { HomeAssistantDeviceAdapter } from "./homeassistant";
import { PlugAwareAdapter, plugFromEnv } from "./plug";
import { SandboxDeviceAdapter } from "./sandbox";
import type { DeviceAdapter } from "./types";
import { WebhookDeviceAdapter } from "./webhook";

export type { DeviceAdapter, DeviceExecutionContext } from "./types";
export { PlugSettingsSchema, describePlug, plugFromEnv, checkPlug, type PlugSettings } from "./plug";

export function createDeviceAdapter(
  cfg: AppConfig["devices"],
  deps: { store: StateStore; fetchImpl: FetchLike; timeoutMs: number },
): DeviceAdapter {
  const base = createBaseAdapter(cfg, deps);
  const ha = cfg.homeAssistantUrl && cfg.homeAssistantToken ? { url: cfg.homeAssistantUrl, token: cfg.homeAssistantToken } : undefined;
  return new PlugAwareAdapter(base, { ...deps, ha, envPlug: plugFromEnv(cfg.plug) });
}

function createBaseAdapter(
  cfg: AppConfig["devices"],
  deps: { store: StateStore; fetchImpl: FetchLike; timeoutMs: number },
): DeviceAdapter {
  switch (cfg.adapter) {
    case "homeassistant":
      if (!cfg.homeAssistantUrl || !cfg.homeAssistantToken) {
        throw new AppError("config_missing", "DEVICE_ADAPTER=homeassistant requires HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN.");
      }
      return new HomeAssistantDeviceAdapter({
        url: cfg.homeAssistantUrl,
        token: cfg.homeAssistantToken,
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
        store: deps.store,
      });
    case "webhook":
      if (!cfg.webhookUrl || !cfg.webhookSecret) {
        throw new AppError("config_missing", "DEVICE_ADAPTER=webhook requires DEVICE_WEBHOOK_URL and DEVICE_WEBHOOK_SECRET.");
      }
      return new WebhookDeviceAdapter({
        url: cfg.webhookUrl,
        secret: cfg.webhookSecret,
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
        store: deps.store,
      });
    case "sandbox":
    default:
      return new SandboxDeviceAdapter(deps.store);
  }
}
