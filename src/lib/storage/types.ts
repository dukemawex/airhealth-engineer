import type { Approval, Intervention, Session } from "../domain";

export type DeviceState = Record<string, unknown> & { deviceId: string; deviceType: string; updatedAt: string };

/**
 * Storage abstraction for all agent state. Implementations:
 *  - RedisStateStore (Upstash Redis / Vercel KV REST) for Vercel and any serverless host
 *  - MemoryStateStore for local development and tests (not durable, single process)
 */
export interface StateStore {
  readonly kind: "redis" | "memory";

  getSession(id: string): Promise<Session | null>;
  putSession(session: Session): Promise<void>;

  getApproval(id: string): Promise<Approval | null>;
  putApproval(approval: Approval): Promise<void>;
  listApprovals(sessionId: string): Promise<Approval[]>;

  getIntervention(id: string): Promise<Intervention | null>;
  putIntervention(intervention: Intervention): Promise<void>;
  listInterventions(sessionId: string): Promise<Intervention[]>;

  getDeviceStates(sessionId: string): Promise<DeviceState[]>;
  putDeviceState(sessionId: string, state: DeviceState): Promise<void>;

  /** Index of sessions that have a location and should be re-checked by the monitor. */
  addMonitoredSession(sessionId: string): Promise<void>;
  removeMonitoredSession(sessionId: string): Promise<void>;
  listMonitoredSessions(limit: number): Promise<string[]>;

  /** Acquire a mutex; returns a token when acquired, null when already held. */
  acquireLock(key: string, ttlMs: number): Promise<string | null>;
  releaseLock(key: string, token: string): Promise<void>;

  /** Short-lived JSON cache (forecast per rounded location/hour, plan text). Optional for test doubles. */
  getCache?<T>(key: string): Promise<T | null>;
  putCache?(key: string, value: unknown, ttlSeconds: number): Promise<void>;

  /** Connectivity check for /api/health. */
  ping(): Promise<boolean>;
}
