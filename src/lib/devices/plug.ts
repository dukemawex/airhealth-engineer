import { z } from "zod";
import type { DeviceActionResult, DeviceCommand } from "../domain";
import { UpstreamError } from "../errors";
import { fetchWithTimeout, readJsonSafe, type FetchLike } from "../http";
import { nowIso } from "../ids";
import type { DeviceState, StateStore } from "../storage";
import type { DeviceAdapter, DeviceExecutionContext } from "./types";

/**
 * Smart plug control. A purifier (or fan) plugged into a smart plug can be
 * switched on and off; speed and mode cannot. Plug commands only ever run
 * from the approval endpoint, after a human approves them, like every other
 * device action. Failures are reported as failures, never as success.
 *
 *   Shelly Gen2/Gen3 local RPC: GET http://<ip>/rpc/Switch.Set?id=0&on=true
 *   Shelly Cloud Control API v2: POST https://<server>/v2/devices/api/set/switch?auth_key=…
 *   Home Assistant: POST /api/services/switch/turn_on {entity_id: "switch.…"}
 */

/** Private LAN address or mDNS name: the only hosts a user can point local RPC at from the UI. */
const PRIVATE_HOST =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9][a-z0-9-]{0,62}\.local)(?::\d{1,5})?$/i;
/** Shelly Cloud servers look like shelly-42-eu.shelly.cloud. */
const SHELLY_CLOUD_HOST = /^shelly-\d{1,4}-[a-z]{2,10}\.shelly\.cloud$/i;

const stripScheme = (s: string) => s.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");

export const PlugSettingsSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("shelly_local"),
    host: z.string().transform(stripScheme).pipe(z.string().regex(PRIVATE_HOST, "Use the plug's LAN address, e.g. 192.168.1.50")),
    switchId: z.number().int().min(0).max(7).default(0),
  }),
  z.object({
    provider: z.literal("shelly_cloud"),
    server: z.string().transform(stripScheme).pipe(z.string().regex(SHELLY_CLOUD_HOST, "Server looks like shelly-42-eu.shelly.cloud")),
    deviceId: z.string().trim().regex(/^[0-9a-f]{6,32}$/i, "Device Id is the hex id from the Shelly app"),
    channel: z.number().int().min(0).max(7).default(0),
    authKey: z.string().trim().min(16).max(400),
  }),
  z.object({
    provider: z.literal("homeassistant"),
    entityId: z.string().trim().regex(/^switch\.[a-z0-9_]{1,120}$/, "Use a switch entity, e.g. switch.purifier_plug"),
  }),
]);
export type PlugSettings = z.infer<typeof PlugSettingsSchema>;
export type PlugProvider = PlugSettings["provider"];

/** Plug settings from the environment (operator-set; hosts are not restricted). */
export interface EnvPlugConfig {
  provider?: PlugProvider;
  shellyHost?: string;
  shellySwitchId?: number;
  shellyCloudServer?: string;
  shellyCloudAuthKey?: string;
  shellyCloudDeviceId?: string;
  shellyCloudChannel?: number;
  haEntity?: string;
}

export function plugFromEnv(e: EnvPlugConfig): PlugSettings | null {
  switch (e.provider) {
    case "shelly_local":
      return e.shellyHost ? { provider: "shelly_local", host: stripScheme(e.shellyHost), switchId: e.shellySwitchId ?? 0 } : null;
    case "shelly_cloud":
      return e.shellyCloudServer && e.shellyCloudAuthKey && e.shellyCloudDeviceId
        ? {
            provider: "shelly_cloud",
            server: stripScheme(e.shellyCloudServer),
            deviceId: e.shellyCloudDeviceId,
            channel: e.shellyCloudChannel ?? 0,
            authKey: e.shellyCloudAuthKey,
          }
        : null;
    case "homeassistant":
      return e.haEntity ? { provider: "homeassistant", entityId: e.haEntity } : null;
    default:
      return null;
  }
}

/** Public, secret-free description of a plug (never includes the auth key). */
export function describePlug(p: PlugSettings): string {
  switch (p.provider) {
    case "shelly_local":
      return `Shelly (local RPC) at ${p.host}, switch ${p.switchId}`;
    case "shelly_cloud":
      return `Shelly Cloud device ${p.deviceId}, channel ${p.channel} via ${p.server}`;
    case "homeassistant":
      return `Home Assistant ${p.entityId}`;
  }
}

/** Which purifier commands a plug can carry out, and how. Null = not a plug action. */
export function plugAction(cmd: DeviceCommand): { on: boolean; note?: string } | null {
  if (cmd.deviceType !== "air_purifier") return null;
  switch (cmd.action) {
    case "turn_on":
      return { on: true };
    case "turn_off":
      return { on: false };
    case "set_fan_speed":
      return cmd.fanSpeedPercent === 0
        ? { on: false }
        : { on: true, note: `A plug only switches power: set ${cmd.fanSpeedPercent}% speed on the purifier itself.` };
    case "set_mode":
      return { on: true, note: `A plug only switches power: choose ${cmd.mode ?? "the"} mode on the purifier itself.` };
  }
}

export interface PlugRequest {
  url: string;
  init: RequestInit;
}

/** The exact HTTP call for switching a plug (pure, for tests and docs). */
export function plugSwitchRequest(p: PlugSettings, on: boolean, ha?: { url: string; token: string }): PlugRequest {
  switch (p.provider) {
    case "shelly_local":
      return { url: `http://${p.host}/rpc/Switch.Set?id=${p.switchId}&on=${on}`, init: { method: "GET" } };
    case "shelly_cloud":
      return {
        url: `https://${p.server}/v2/devices/api/set/switch?auth_key=${encodeURIComponent(p.authKey)}`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: p.deviceId, channel: p.channel, on }),
        },
      };
    case "homeassistant":
      if (!ha) throw new UpstreamError({ service: "home-assistant", message: "HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN are required for a Home Assistant plug", retryable: false });
      return {
        url: `${ha.url}/api/services/switch/${on ? "turn_on" : "turn_off"}`,
        init: {
          method: "POST",
          headers: { Authorization: `Bearer ${ha.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ entity_id: p.entityId }),
        },
      };
  }
}

/** Read-only state request (used by "Check connection"; never switches anything). */
export function plugStatusRequest(p: PlugSettings, ha?: { url: string; token: string }): PlugRequest {
  switch (p.provider) {
    case "shelly_local":
      return { url: `http://${p.host}/rpc/Switch.GetStatus?id=${p.switchId}`, init: { method: "GET" } };
    case "shelly_cloud":
      return {
        url: `https://${p.server}/v2/devices/api/get?auth_key=${encodeURIComponent(p.authKey)}`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [p.deviceId], select: ["status"] }),
        },
      };
    case "homeassistant":
      if (!ha) throw new UpstreamError({ service: "home-assistant", message: "HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN are required for a Home Assistant plug", retryable: false });
      return { url: `${ha.url}/api/states/${p.entityId}`, init: { method: "GET", headers: { Authorization: `Bearer ${ha.token}` } } };
  }
}

const SERVICE: Record<PlugProvider, string> = { shelly_local: "shelly", shelly_cloud: "shelly-cloud", homeassistant: "home-assistant" };

/** Interpret a status body into on/off/online, defensively. */
export function readPlugStatus(p: PlugSettings, body: unknown): { on: boolean | null; online: boolean } {
  const b = body as Record<string, unknown> | undefined;
  if (p.provider === "shelly_local") return { on: typeof b?.output === "boolean" ? b.output : null, online: true };
  if (p.provider === "homeassistant") {
    const s = b?.state;
    return { on: s === "on" ? true : s === "off" ? false : null, online: s !== "unavailable" };
  }
  const dev = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
  const status = dev?.status as Record<string, unknown> | undefined;
  const sw = status?.[`switch:${p.channel}`] as Record<string, unknown> | undefined;
  return { on: typeof sw?.output === "boolean" ? sw.output : null, online: dev?.online === 1 || dev?.online === true };
}

function maskSecrets(text: string, p: PlugSettings): string {
  return p.provider === "shelly_cloud" ? text.split(p.authKey).join("***").split(encodeURIComponent(p.authKey)).join("***") : text;
}

export interface PlugDeps {
  fetchImpl: FetchLike;
  timeoutMs: number;
  ha?: { url: string; token: string };
}

async function call(p: PlugSettings, req: PlugRequest, deps: PlugDeps, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithTimeout(deps.fetchImpl, req.url, req.init, deps.timeoutMs);
  } catch (err) {
    const hint =
      p.provider === "shelly_local"
        ? " Local RPC only works when this app runs on the same network as the plug (for example `npm start` at home); a cloud deployment cannot reach your LAN. Use Shelly Cloud instead."
        : "";
    throw new UpstreamError({
      service: SERVICE[p.provider],
      message: maskSecrets(`${what}: plug not reachable (${err instanceof Error ? err.message : "network error"}).${hint}`, p),
      retryable: false,
    });
  }
  const body = await readJsonSafe(res);
  const errField = (body as { error?: unknown } | undefined)?.error;
  if (!res.ok || (p.provider === "shelly_local" && errField)) {
    const detail = typeof errField === "string" ? ` ${errField}` : errField && typeof errField === "object" ? ` ${JSON.stringify(errField).slice(0, 160)}` : "";
    throw new UpstreamError({
      service: SERVICE[p.provider],
      status: res.status,
      message: maskSecrets(`${what} failed with HTTP ${res.status}.${detail}`, p),
      retryable: false,
    });
  }
  return body;
}

/** Switch the plug. Throws on any failure: callers must never report success without this resolving. */
export async function switchPlug(p: PlugSettings, on: boolean, deps: PlugDeps): Promise<{ wasOn: boolean | null; raw: unknown }> {
  const body = await call(p, plugSwitchRequest(p, on, deps.ha), deps, `${describePlug(p)} switch ${on ? "on" : "off"}`);
  const wasOn = p.provider === "shelly_local" && typeof (body as { was_on?: unknown })?.was_on === "boolean" ? (body as { was_on: boolean }).was_on : null;
  return { wasOn, raw: body };
}

export async function checkPlug(p: PlugSettings, deps: PlugDeps) {
  const body = await call(p, plugStatusRequest(p, deps.ha), deps, `${describePlug(p)} status`);
  return readPlugStatus(p, body);
}

/**
 * Wraps the configured adapter: purifier power commands go to the smart plug
 * when one is set (per conversation in the Devices panel, else from env);
 * everything else goes to the base adapter unchanged.
 */
export class PlugAwareAdapter implements DeviceAdapter {
  readonly name: DeviceAdapter["name"];
  constructor(
    private readonly base: DeviceAdapter,
    private readonly opts: PlugDeps & { store: StateStore; envPlug: PlugSettings | null },
  ) {
    this.name = base.name;
  }

  async resolvePlug(sessionId: string): Promise<{ plug: PlugSettings; source: "session" | "env" } | null> {
    const s = await this.opts.store.getSession(sessionId);
    if (s?.plug) return { plug: s.plug, source: "session" };
    return this.opts.envPlug ? { plug: this.opts.envPlug, source: "env" } : null;
  }

  async execute(command: DeviceCommand, ctx: DeviceExecutionContext): Promise<DeviceActionResult> {
    const action = plugAction(command);
    const resolved = action ? await this.resolvePlug(ctx.sessionId) : null;
    if (!action || !resolved) {
      const r = await this.base.execute(command, ctx);
      if (action && this.base.name === "sandbox") {
        return { ...r, message: `${r.message} No smart plug connected: add one in Devices → Smart plug to switch a real purifier.` };
      }
      return r;
    }
    const { plug } = resolved;
    const out = await switchPlug(plug, action.on, this.opts);
    const existing = (await this.opts.store.getDeviceStates(ctx.sessionId)).find((d) => d.deviceId === command.deviceId);
    const state: DeviceState = {
      ...(existing ?? {}),
      deviceId: command.deviceId,
      deviceType: command.deviceType,
      power: action.on ? "on" : "off",
      updatedAt: nowIso(),
      lastApprovalId: ctx.approvalId,
      lastCommand: command,
    };
    await this.opts.store.putDeviceState(ctx.sessionId, state);
    const was = out.wasOn === null ? "" : ` (was ${out.wasOn ? "on" : "off"})`;
    return {
      ok: true,
      adapter: `smartplug:${plug.provider}`,
      executedAt: nowIso(),
      message: `${describePlug(plug)} switched ${action.on ? "on" : "off"}${was}.${action.note ? ` ${action.note}` : ""}`,
      deviceState: state,
    };
  }

  getStates(sessionId: string) {
    return this.base.getStates(sessionId);
  }
}
