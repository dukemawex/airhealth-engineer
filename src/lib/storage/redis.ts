import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { Approval, Intervention, Session } from "../domain";
import type { DeviceState, StateStore } from "./types";

const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Upstash Redis (REST) store. Works with Upstash directly or with the Upstash
 * integration from the Vercel Marketplace (which injects KV_REST_API_URL /
 * KV_REST_API_TOKEN).
 */
export class RedisStateStore implements StateStore {
  readonly kind = "redis" as const;
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly ttlSeconds: number;

  constructor(opts: { url: string; token: string; prefix: string; ttlSeconds: number; client?: Redis }) {
    this.redis = opts.client ?? new Redis({ url: opts.url, token: opts.token });
    this.prefix = opts.prefix;
    this.ttlSeconds = opts.ttlSeconds;
  }

  private k(...parts: string[]) {
    return [this.prefix, ...parts].join(":");
  }

  private async putJson(key: string, value: unknown) {
    await this.redis.set(key, JSON.stringify(value), { ex: this.ttlSeconds });
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get<unknown>(key);
    if (raw === null || raw === undefined) return null;
    // @upstash/redis auto-deserializes JSON strings by default.
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
  }

  private async index(setKey: string, member: string) {
    await this.redis.sadd(setKey, member);
    await this.redis.expire(setKey, this.ttlSeconds);
  }

  private async listByIndex<T extends { createdAt: string }>(setKey: string, kind: string): Promise<T[]> {
    const ids = await this.redis.smembers(setKey);
    if (ids.length === 0) return [];
    const items = await Promise.all(ids.map((id) => this.getJson<T>(this.k(kind, String(id)))));
    return items.filter((x): x is Awaited<T> => x !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getCache<T>(key: string) {
    return this.getJson<T>(this.k("cache", key));
  }
  async putCache(key: string, value: unknown, ttlSeconds: number) {
    await this.redis.set(this.k("cache", key), JSON.stringify(value), { ex: Math.max(1, Math.round(ttlSeconds)) });
  }

  getSession(id: string) {
    return this.getJson<Session>(this.k("session", id));
  }
  putSession(session: Session) {
    return this.putJson(this.k("session", session.id), session);
  }

  getApproval(id: string) {
    return this.getJson<Approval>(this.k("approval", id));
  }
  async putApproval(approval: Approval) {
    await this.putJson(this.k("approval", approval.id), approval);
    await this.index(this.k("session", approval.sessionId, "approvals"), approval.id);
  }
  listApprovals(sessionId: string) {
    return this.listByIndex<Approval>(this.k("session", sessionId, "approvals"), "approval");
  }

  getIntervention(id: string) {
    return this.getJson<Intervention>(this.k("intervention", id));
  }
  async putIntervention(intervention: Intervention) {
    await this.putJson(this.k("intervention", intervention.id), intervention);
    await this.index(this.k("session", intervention.sessionId, "interventions"), intervention.id);
  }
  listInterventions(sessionId: string) {
    return this.listByIndex<Intervention>(this.k("session", sessionId, "interventions"), "intervention");
  }

  async getDeviceStates(sessionId: string) {
    const hash = await this.redis.hgetall<Record<string, unknown>>(this.k("session", sessionId, "devices"));
    if (!hash) return [];
    return Object.values(hash).map((v) => (typeof v === "string" ? JSON.parse(v) : v) as DeviceState);
  }
  async putDeviceState(sessionId: string, state: DeviceState) {
    const key = this.k("session", sessionId, "devices");
    await this.redis.hset(key, { [state.deviceId]: JSON.stringify(state) });
    await this.redis.expire(key, this.ttlSeconds);
  }

  async addMonitoredSession(sessionId: string) {
    await this.redis.sadd(this.k("monitored"), sessionId);
  }
  async removeMonitoredSession(sessionId: string) {
    await this.redis.srem(this.k("monitored"), sessionId);
  }
  async listMonitoredSessions(limit: number) {
    const ids = await this.redis.srandmember<string[]>(this.k("monitored"), limit);
    return (ids ?? []).map(String);
  }

  async acquireLock(key: string, ttlMs: number) {
    const token = randomUUID();
    const ok = await this.redis.set(this.k("lock", key), token, { nx: true, px: ttlMs });
    return ok === "OK" ? token : null;
  }
  async releaseLock(key: string, token: string) {
    await this.redis.eval(RELEASE_SCRIPT, [this.k("lock", key)], [token]);
  }

  async ping() {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }
}
