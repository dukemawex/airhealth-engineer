import { z } from "zod";

/**
 * Environment configuration, validated with zod. Nothing here throws at import
 * time: missing optional integrations are reported by /api/health and only
 * fail the specific feature that needs them.
 */

const boolFromEnv = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .optional()
  .transform((v) => (v === undefined ? undefined : ["true", "1", "yes"].includes(v)));

const intFromEnv = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

const EnvSchema = z.object({
  // Meta Model API (Muse Spark). Docs: https://dev.meta.ai/docs/api-reference
  MODEL_API_KEY: optionalString,
  META_API_BASE_URL: z.preprocess(emptyToUndefined, z.url().default("https://api.meta.ai/v1")),
  META_MODEL_ID: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^muse-spark[-a-z0-9.]*$/, "META_MODEL_ID must be a Muse Spark model id (e.g. muse-spark-1.3)")
      .default("muse-spark-1.3"),
  ),
  META_REASONING_EFFORT: z.preprocess(
    emptyToUndefined,
    z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  ),
  META_PARALLEL_TOOL_CALLS: boolFromEnv,
  META_TIMEOUT_MS: intFromEnv(55_000, 1_000, 300_000),
  META_MAX_RETRIES: intFromEnv(3, 0, 6),

  // Agent loop
  AGENT_MAX_ITERATIONS: intFromEnv(8, 1, 25),
  AGENT_RUN_BUDGET_MS: intFromEnv(270_000, 5_000, 800_000),
  TOOL_TIMEOUT_MS: intFromEnv(20_000, 1_000, 120_000),
  APPROVAL_TTL_MINUTES: intFromEnv(60, 1, 10_080),

  // Air quality
  OPENAQ_API_KEY: optionalString,
  OPENAQ_BASE_URL: z.preprocess(emptyToUndefined, z.url().default("https://api.openaq.org/v3")),
  AIR_QUALITY_MODEL_FALLBACK: boolFromEnv,
  GEOCODING_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.url().default("https://geocoding-api.open-meteo.com/v1"),
  ),
  AIR_QUALITY_MODEL_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.url().default("https://air-quality-api.open-meteo.com/v1"),
  ),

  // Devices
  DEVICE_ADAPTER: z.preprocess(
    emptyToUndefined,
    z.enum(["sandbox", "homeassistant", "webhook"]).default("sandbox"),
  ),
  HOME_ASSISTANT_URL: optionalUrl,
  HOME_ASSISTANT_TOKEN: optionalString,
  DEVICE_WEBHOOK_URL: optionalUrl,
  DEVICE_WEBHOOK_SECRET: optionalString,

  // Storage (Upstash Redis / Vercel KV-compatible REST credentials)
  UPSTASH_REDIS_REST_URL: optionalUrl,
  UPSTASH_REDIS_REST_TOKEN: optionalString,
  KV_REST_API_URL: optionalUrl,
  KV_REST_API_TOKEN: optionalString,
  STORAGE_KEY_PREFIX: z.preprocess(emptyToUndefined, z.string().default("ahe")),
  STATE_TTL_DAYS: intFromEnv(30, 1, 365),

  // API protection
  API_AUTH_TOKEN: optionalString,
  // Monitoring. CRON_SECRET is sent by Vercel Cron as "Authorization: Bearer <CRON_SECRET>".
  CRON_SECRET: optionalString,
  MONITOR_MIN_INTERVAL_MINUTES: intFromEnv(10, 1, 1440),
  MONITOR_MAX_SESSIONS_PER_RUN: intFromEnv(20, 1, 200),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  meta: {
    apiKey?: string;
    baseUrl: string;
    modelId: string;
    reasoningEffort?: Env["META_REASONING_EFFORT"];
    parallelToolCalls: boolean;
    timeoutMs: number;
    maxRetries: number;
  };
  agent: {
    maxIterations: number;
    runBudgetMs: number;
    toolTimeoutMs: number;
    approvalTtlMs: number;
  };
  airQuality: {
    openaqApiKey?: string;
    openaqBaseUrl: string;
    modelFallback: boolean;
    geocodingBaseUrl: string;
    modelBaseUrl: string;
  };
  devices: {
    adapter: Env["DEVICE_ADAPTER"];
    homeAssistantUrl?: string;
    homeAssistantToken?: string;
    webhookUrl?: string;
    webhookSecret?: string;
  };
  storage: {
    redisUrl?: string;
    redisToken?: string;
    keyPrefix: string;
    ttlSeconds: number;
  };
  apiAuthToken?: string;
  monitoring: {
    cronSecret?: string;
    minIntervalMs: number;
    maxSessionsPerRun: number;
  };
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid environment configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function parseConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    meta: {
      apiKey: e.MODEL_API_KEY,
      baseUrl: e.META_API_BASE_URL.replace(/\/+$/, ""),
      modelId: e.META_MODEL_ID,
      reasoningEffort: e.META_REASONING_EFFORT,
      // One call per turn keeps approval pauses simple to reason about; the loop
      // still handles parallel calls correctly if you enable them.
      parallelToolCalls: e.META_PARALLEL_TOOL_CALLS ?? false,
      timeoutMs: e.META_TIMEOUT_MS,
      maxRetries: e.META_MAX_RETRIES,
    },
    agent: {
      maxIterations: e.AGENT_MAX_ITERATIONS,
      runBudgetMs: e.AGENT_RUN_BUDGET_MS,
      toolTimeoutMs: e.TOOL_TIMEOUT_MS,
      approvalTtlMs: e.APPROVAL_TTL_MINUTES * 60_000,
    },
    airQuality: {
      openaqApiKey: e.OPENAQ_API_KEY,
      openaqBaseUrl: e.OPENAQ_BASE_URL.replace(/\/+$/, ""),
      modelFallback: e.AIR_QUALITY_MODEL_FALLBACK ?? true,
      geocodingBaseUrl: e.GEOCODING_BASE_URL.replace(/\/+$/, ""),
      modelBaseUrl: e.AIR_QUALITY_MODEL_BASE_URL.replace(/\/+$/, ""),
    },
    devices: {
      adapter: e.DEVICE_ADAPTER,
      homeAssistantUrl: e.HOME_ASSISTANT_URL?.replace(/\/+$/, ""),
      homeAssistantToken: e.HOME_ASSISTANT_TOKEN,
      webhookUrl: e.DEVICE_WEBHOOK_URL,
      webhookSecret: e.DEVICE_WEBHOOK_SECRET,
    },
    storage: {
      redisUrl: e.UPSTASH_REDIS_REST_URL ?? e.KV_REST_API_URL,
      redisToken: e.UPSTASH_REDIS_REST_TOKEN ?? e.KV_REST_API_TOKEN,
      keyPrefix: e.STORAGE_KEY_PREFIX,
      ttlSeconds: e.STATE_TTL_DAYS * 86_400,
    },
    apiAuthToken: e.API_AUTH_TOKEN,
    monitoring: {
      cronSecret: e.CRON_SECRET,
      minIntervalMs: e.MONITOR_MIN_INTERVAL_MINUTES * 60_000,
      maxSessionsPerRun: e.MONITOR_MAX_SESSIONS_PER_RUN,
    },
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cached) cached = parseConfig();
  return cached;
}

/** For tests only. */
export function resetConfigCache() {
  cached = undefined;
}
