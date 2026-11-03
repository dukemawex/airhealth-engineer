import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { ConfigError, getConfig } from "@/lib/config";
import { getCapabilities } from "@/lib/meta/media";
import { getStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public liveness + configuration presence. Never returns secret values. */
export const GET = route(
  "health",
  async ({ log: logger }) => {
    let config;
    try {
      config = getConfig();
    } catch (err) {
      return NextResponse.json(
        { status: "misconfigured", issues: err instanceof ConfigError ? err.issues : ["invalid configuration"] },
        { status: 503 },
      );
    }
    const store = getStore(config.storage);
    const [storageOk, caps] = await Promise.all([
      store.ping().catch(() => false),
      config.meta.apiKey ? getCapabilities({ cfg: config.meta, logger }).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    const devicesConfigured =
      config.devices.adapter === "sandbox" ||
      (config.devices.adapter === "homeassistant" && Boolean(config.devices.homeAssistantUrl && config.devices.homeAssistantToken)) ||
      (config.devices.adapter === "webhook" && Boolean(config.devices.webhookUrl && config.devices.webhookSecret));
    const metaConfigured = Boolean(config.meta.apiKey);
    const aqConfigured = Boolean(config.airQuality.openaqApiKey) || config.airQuality.modelFallback;
    const ready = metaConfigured && aqConfigured && storageOk && devicesConfigured;
    return NextResponse.json(
      {
        status: ready ? "ok" : "degraded",
        time: new Date().toISOString(),
        checks: {
          metaModelApi: { configured: metaConfigured, model: config.meta.modelId, baseUrl: config.meta.baseUrl },
          metaCapabilities: caps
            ? { reachable: caps.reachable, checkedAt: caps.checkedAt, features: caps.features }
            : { reachable: false, features: null },
          openaq: { configured: Boolean(config.airQuality.openaqApiKey), modelFallbackEnabled: config.airQuality.modelFallback },
          storage: { kind: store.kind, reachable: storageOk, durable: store.kind === "redis" },
          devices: { adapter: config.devices.adapter, configured: devicesConfigured },
          apiAuth: { enabled: Boolean(config.apiAuthToken) },
          monitoring: {
            cronSecretConfigured: Boolean(config.monitoring.cronSecret),
            minIntervalMinutes: Math.round(config.monitoring.minIntervalMs / 60000),
            maxSessionsPerRun: config.monitoring.maxSessionsPerRun,
          },
        },
      },
      { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  },
  { auth: false },
);
