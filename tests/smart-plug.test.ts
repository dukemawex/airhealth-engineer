import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "@/lib/config";
import { createDeviceAdapter } from "@/lib/devices";
import { toHomeAssistantCall } from "@/lib/devices/homeassistant";
import {
  PlugSettingsSchema,
  plugAction,
  plugFromEnv,
  plugSwitchRequest,
  readPlugStatus,
  type PlugSettings,
} from "@/lib/devices/plug";
import { MemoryStateStore } from "@/lib/storage/memory";
import { reply, setup, toolCall } from "./helpers";

const AUTH = "MTIzNDU2Nzg5MGFiY2RlZg_test_key";
const cloudEnv = {
  PLUG_PROVIDER: "shelly_cloud",
  SHELLY_CLOUD_SERVER: "shelly-42-eu.shelly.cloud",
  SHELLY_CLOUD_AUTH_KEY: AUTH,
  SHELLY_CLOUD_DEVICE_ID: "a8032ab1c2d3",
};
const on = { deviceType: "air_purifier", deviceId: "purifier.bedroom", action: "turn_on" } as const;
const ctx = { sessionId: "ses_1", approvalId: "apr_1", approvedBy: "duke" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("smart plug requests", () => {
  it("builds the Shelly Gen2 local RPC call", () => {
    const p: PlugSettings = { provider: "shelly_local", host: "192.168.1.50", switchId: 0 };
    expect(plugSwitchRequest(p, true).url).toBe("http://192.168.1.50/rpc/Switch.Set?id=0&on=true");
    expect(plugSwitchRequest(p, false).url).toBe("http://192.168.1.50/rpc/Switch.Set?id=0&on=false");
  });

  it("builds the Shelly Cloud v2 set/switch call", () => {
    const p = plugFromEnv(parseConfig(cloudEnv).devices.plug)!;
    const r = plugSwitchRequest(p, true);
    expect(r.url).toBe(`https://shelly-42-eu.shelly.cloud/v2/devices/api/set/switch?auth_key=${encodeURIComponent(AUTH)}`);
    expect(r.init.method).toBe("POST");
    expect(JSON.parse(String(r.init.body))).toEqual({ id: "a8032ab1c2d3", channel: 0, on: true });
  });

  it("maps Home Assistant switch entities to switch.turn_on/turn_off", () => {
    const p: PlugSettings = { provider: "homeassistant", entityId: "switch.purifier_plug" };
    const r = plugSwitchRequest(p, false, { url: "http://ha.local:8123", token: "t" });
    expect(r.url).toBe("http://ha.local:8123/api/services/switch/turn_off");
    expect(JSON.parse(String(r.init.body))).toEqual({ entity_id: "switch.purifier_plug" });
    expect(toHomeAssistantCall({ ...on, deviceId: "switch.purifier_plug" })).toEqual({
      domain: "switch",
      service: "turn_on",
      data: { entity_id: "switch.purifier_plug" },
    });
    expect(() => toHomeAssistantCall({ deviceType: "air_purifier", deviceId: "switch.p", action: "set_fan_speed", fanSpeedPercent: 50 })).toThrow(/only turn/);
  });

  it("is honest about what a plug can do", () => {
    expect(plugAction(on)).toEqual({ on: true });
    expect(plugAction({ ...on, action: "turn_off" })).toEqual({ on: false });
    expect(plugAction({ ...on, action: "set_fan_speed", fanSpeedPercent: 0 })).toEqual({ on: false });
    expect(plugAction({ ...on, action: "set_fan_speed", fanSpeedPercent: 80 })?.note).toMatch(/only switches power/);
    expect(plugAction({ deviceType: "window", deviceId: "cover.w", action: "close" })).toBeNull();
  });

  it("only accepts LAN hosts and real Shelly Cloud servers from the panel", () => {
    expect(PlugSettingsSchema.safeParse({ provider: "shelly_local", host: "http://192.168.1.50/" }).data).toMatchObject({ host: "192.168.1.50", switchId: 0 });
    expect(PlugSettingsSchema.safeParse({ provider: "shelly_local", host: "shellyplus1pm.local" }).success).toBe(true);
    for (const host of ["8.8.8.8", "169.254.169.254", "example.com", "127.0.0.1"]) {
      expect(PlugSettingsSchema.safeParse({ provider: "shelly_local", host }).success).toBe(false);
    }
    const cloud = { provider: "shelly_cloud", deviceId: "a8032ab1c2d3", authKey: AUTH };
    expect(PlugSettingsSchema.safeParse({ ...cloud, server: "shelly-42-eu.shelly.cloud" }).success).toBe(true);
    expect(PlugSettingsSchema.safeParse({ ...cloud, server: "evil.example.com" }).success).toBe(false);
    expect(PlugSettingsSchema.safeParse({ provider: "homeassistant", entityId: "light.kitchen" }).success).toBe(false);
  });

  it("reads plug status without switching", () => {
    expect(readPlugStatus({ provider: "shelly_local", host: "10.0.0.2", switchId: 0 }, { id: 0, output: true })).toEqual({ on: true, online: true });
    const p = plugFromEnv(parseConfig(cloudEnv).devices.plug)!;
    expect(readPlugStatus(p, [{ id: "a8032ab1c2d3", online: 1, status: { "switch:0": { output: false } } }])).toEqual({ on: false, online: true });
  });
});

describe("plug-aware adapter", () => {
  it("with nothing configured, stays in the sandbox and says no plug is connected", async () => {
    const fetchImpl = vi.fn();
    const store = new MemoryStateStore();
    const adapter = createDeviceAdapter(parseConfig({}).devices, { store, fetchImpl, timeoutMs: 1000 });
    const r = await adapter.execute(on, ctx);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.adapter).toBe("sandbox");
    expect(r.message).toMatch(/SANDBOX/);
    expect(r.message).toMatch(/No smart plug connected/);
  });

  it("switches the configured plug and records the state", async () => {
    const fetchImpl = vi.fn(async () => json({ was_on: false }));
    const store = new MemoryStateStore();
    const cfg = parseConfig({ PLUG_PROVIDER: "shelly_local", SHELLY_HOST: "192.168.1.50" }).devices;
    const adapter = createDeviceAdapter(cfg, { store, fetchImpl, timeoutMs: 1000 });
    const r = await adapter.execute(on, ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe("http://192.168.1.50/rpc/Switch.Set?id=0&on=true");
    expect(r).toMatchObject({ ok: true, adapter: "smartplug:shelly_local" });
    expect(r.message).toMatch(/switched on \(was off\)/);
    expect((await store.getDeviceStates("ses_1"))[0]).toMatchObject({ power: "on", lastApprovalId: "apr_1" });
  });

  it("non-power commands still go to the base adapter", async () => {
    const fetchImpl = vi.fn();
    const store = new MemoryStateStore();
    const cfg = parseConfig({ PLUG_PROVIDER: "shelly_local", SHELLY_HOST: "192.168.1.50" }).devices;
    const r = await createDeviceAdapter(cfg, { store, fetchImpl, timeoutMs: 1000 }).execute(
      { deviceType: "window", deviceId: "w", action: "close" },
      ctx,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.adapter).toBe("sandbox");
  });

  it("a cloud error throws (never a faked success) and the auth key is masked", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "DEVICE_OFFLINE", data: { messages: [AUTH] } }, 400));
    const store = new MemoryStateStore();
    const adapter = createDeviceAdapter(parseConfig(cloudEnv).devices, { store, fetchImpl, timeoutMs: 1000 });
    const err = await adapter.execute(on, ctx).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 400/);
    expect((err as Error).message).toMatch(/DEVICE_OFFLINE/);
    expect((err as Error).message).not.toContain(AUTH);
    expect(await store.getDeviceStates("ses_1")).toEqual([]);
  });
});

describe("plug behind the approval gate", () => {
  const exec = toolCall("executeDeviceAction", { command: on, reason: "PM2.5 is high indoors" });

  it("does not touch the plug until approved, then switches it once", async () => {
    const { runner, fetchImpl } = setup({ steps: [reply(null, [exec]), reply("Purifier is on.")], env: cloudEnv });
    fetchImpl.mockImplementation((async () => json({})) as never);
    const s = await runner.createSession({});
    const paused = await runner.sendMessage(s.id, "turn on my purifier");
    expect(paused.status).toBe("awaiting_approval");
    expect(fetchImpl).not.toHaveBeenCalled();

    const { approval } = await runner.decideApproval(paused.pendingApprovals[0]!.id, "approve", { decidedBy: "duke" });
    expect(approval.status).toBe("executed");
    expect(approval.result).toMatchObject({ ok: true, adapter: "smartplug:shelly_cloud" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an unreachable plug fails the approval instead of pretending", async () => {
    const { runner, fetchImpl } = setup({ steps: [reply(null, [exec]), reply("That didn't work.")], env: cloudEnv });
    fetchImpl.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    const s = await runner.createSession({});
    const paused = await runner.sendMessage(s.id, "turn on my purifier");
    const { approval } = await runner.decideApproval(paused.pendingApprovals[0]!.id, "approve");
    expect(approval.status).toBe("failed");
    expect(approval.result?.ok).toBe(false);
  });

  it("panel settings override env, are never echoed, and HA needs server creds", async () => {
    const { runner } = setup({ steps: [] });
    const s = await runner.createSession({});
    expect(await runner.plugInfo(s.id)).toMatchObject({ connected: false, source: null });
    const info = await runner.setPlug(s.id, PlugSettingsSchema.parse({ provider: "shelly_cloud", server: "shelly-42-eu.shelly.cloud", deviceId: "a8032ab1c2d3", authKey: AUTH }));
    expect(info).toMatchObject({ connected: true, source: "session", provider: "shelly_cloud" });
    expect(JSON.stringify(info)).not.toContain(AUTH);
    await expect(runner.setPlug(s.id, { provider: "homeassistant", entityId: "switch.p" })).rejects.toMatchObject({ code: "config_missing" });
    expect(await runner.setPlug(s.id, null)).toMatchObject({ connected: false });
  });
});
