import type { AppConfig } from "../config";
import { AppError } from "../errors";
import { logger } from "../logger";
import { MemoryStateStore } from "./memory";
import { RedisStateStore } from "./redis";
import type { StateStore } from "./types";

export type { StateStore, DeviceState } from "./types";

let store: StateStore | undefined;

export function createStore(cfg: AppConfig["storage"]): StateStore {
  if (cfg.redisUrl && cfg.redisToken) {
    return new RedisStateStore({
      url: cfg.redisUrl,
      token: cfg.redisToken,
      prefix: cfg.keyPrefix,
      ttlSeconds: cfg.ttlSeconds,
    });
  }
  if (process.env.VERCEL === "1") {
    logger.warn("no Redis credentials on Vercel; falling back to in-memory state (not durable across invocations)");
  }
  return new MemoryStateStore();
}

export function getStore(cfg: AppConfig["storage"]): StateStore {
  if (!store) store = createStore(cfg);
  return store;
}

/** Run fn while holding a store-level mutex, or throw 409 if it is held. */
export async function withLock<T>(s: StateStore, key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const token = await s.acquireLock(key, ttlMs);
  if (!token) throw new AppError("conflict", `Resource is busy (${key}); retry shortly.`);
  try {
    return await fn();
  } finally {
    await s.releaseLock(key, token).catch((err) => logger.warn("failed to release lock", { key, error: err }));
  }
}
