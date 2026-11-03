import { randomUUID } from "node:crypto";
import type { Approval, Intervention, Session } from "../domain";
import type { DeviceState, StateStore } from "./types";

const clone = <T>(v: T): T => structuredClone(v);

/** In-process store for local dev/tests. State is lost on restart and not shared across instances. */
export class MemoryStateStore implements StateStore {
  readonly kind = "memory" as const;
  private sessions = new Map<string, Session>();
  private approvals = new Map<string, Approval>();
  private interventions = new Map<string, Intervention>();
  private devices = new Map<string, Map<string, DeviceState>>();
  private monitored = new Set<string>();
  private locks = new Map<string, { token: string; expiresAt: number }>();
  private cache = new Map<string, { value: unknown; expiresAt: number }>();

  async getCache<T>(key: string) {
    const hit = this.cache.get(key);
    if (!hit || hit.expiresAt < Date.now()) return null;
    return clone(hit.value) as T;
  }
  async putCache(key: string, value: unknown, ttlSeconds: number) {
    this.cache.set(key, { value: clone(value), expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? clone(s) : null;
  }
  async putSession(session: Session) {
    this.sessions.set(session.id, clone(session));
  }

  async getApproval(id: string) {
    const a = this.approvals.get(id);
    return a ? clone(a) : null;
  }
  async putApproval(approval: Approval) {
    this.approvals.set(approval.id, clone(approval));
  }
  async listApprovals(sessionId: string) {
    return [...this.approvals.values()]
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async getIntervention(id: string) {
    const i = this.interventions.get(id);
    return i ? clone(i) : null;
  }
  async putIntervention(intervention: Intervention) {
    this.interventions.set(intervention.id, clone(intervention));
  }
  async listInterventions(sessionId: string) {
    return [...this.interventions.values()]
      .filter((i) => i.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async getDeviceStates(sessionId: string) {
    return [...(this.devices.get(sessionId)?.values() ?? [])].map(clone);
  }
  async putDeviceState(sessionId: string, state: DeviceState) {
    const map = this.devices.get(sessionId) ?? new Map<string, DeviceState>();
    map.set(state.deviceId, clone(state));
    this.devices.set(sessionId, map);
  }

  async addMonitoredSession(sessionId: string) {
    this.monitored.add(sessionId);
  }
  async removeMonitoredSession(sessionId: string) {
    this.monitored.delete(sessionId);
  }
  async listMonitoredSessions(limit: number) {
    return [...this.monitored].slice(0, limit);
  }

  async acquireLock(key: string, ttlMs: number) {
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > Date.now()) return null;
    const token = randomUUID();
    this.locks.set(key, { token, expiresAt: Date.now() + ttlMs });
    return token;
  }
  async releaseLock(key: string, token: string) {
    if (this.locks.get(key)?.token === token) this.locks.delete(key);
  }

  async ping() {
    return true;
  }
}
