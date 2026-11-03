"use client";

/**
 * Web Bluetooth device bridge (Chrome / Edge on desktop and Android, https only).
 *
 * What it can honestly do from a browser:
 * - Connect to a nearby Bluetooth Low Energy device the user picks in the browser's own chooser.
 * - Discover its GATT services and characteristics (only services we list in `optionalServices`
 *   are visible, a Web Bluetooth security rule).
 * - Read standard Environmental Sensing values (temperature, humidity, pressure, CO2, PM) and battery.
 * - After the user approves a device action in AirHealth, write that approved command as a JSON line
 *   to a writable characteristic the user chose (e.g. a Nordic UART / ESP32 bridge that drives an IR
 *   blaster or relay). Nothing is ever written without an approval.
 *
 * What it cannot do: most air conditioners, purifiers and fans are controlled by infrared remotes or
 * vendor Wi-Fi clouds, and Bluetooth ones use proprietary, often encrypted protocols. Those aren't
 * reachable from a web page; a bridge device (or the Home Assistant adapter) is needed.
 */

import type { DeviceCommand } from "@/lib/domain";

/* ---------- Minimal Web Bluetooth typings (lib.dom doesn't ship them) ---------- */
interface BtCharacteristicProps {
  read: boolean;
  write: boolean;
  writeWithoutResponse: boolean;
  notify: boolean;
}
interface BtCharacteristic {
  uuid: string;
  properties: BtCharacteristicProps;
  readValue(): Promise<DataView>;
  writeValueWithResponse?(v: BufferSource): Promise<void>;
  writeValueWithoutResponse?(v: BufferSource): Promise<void>;
  writeValue?(v: BufferSource): Promise<void>;
}
interface BtService {
  uuid: string;
  getCharacteristics(): Promise<BtCharacteristic[]>;
}
interface BtServer {
  connected: boolean;
  connect(): Promise<BtServer>;
  disconnect(): void;
  getPrimaryServices(): Promise<BtService[]>;
}
interface BtDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BtServer;
}
interface BtNavigator {
  bluetooth: {
    getAvailability?(): Promise<boolean>;
    requestDevice(opts: { acceptAllDevices?: boolean; optionalServices?: Array<string | number> }): Promise<BtDevice>;
  };
}

/* ---------------------------------- UUIDs ---------------------------------- */
const uuid16 = (n: number) => `0000${n.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
export const NORDIC_UART = { service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e", rx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e" };

const SERVICE_NAMES: Record<string, string> = {
  [uuid16(0x181a)]: "Environmental Sensing",
  [uuid16(0x180f)]: "Battery",
  [uuid16(0x180a)]: "Device Information",
  [NORDIC_UART.service]: "Nordic UART (bridge)",
};

type Decoder = { label: string; unit: string; decode: (v: DataView) => number | string | null };

/** IEEE-11073 16-bit SFLOAT ("medfloat16"), used by the PM characteristics. */
export function sfloat16(raw: number): number | null {
  if ([0x07ff, 0x0800, 0x07fe, 0x0802, 0x0801].includes(raw)) return null;
  let mantissa = raw & 0x0fff;
  let exponent = raw >> 12;
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  if (exponent >= 0x08) exponent -= 0x10;
  return mantissa * 10 ** exponent;
}

const text = (v: DataView) => new TextDecoder().decode(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)).replace(/\0+$/, "");

/** GATT Specification Supplement decoders (all little-endian). */
export const DECODERS: Record<string, Decoder> = {
  [uuid16(0x2a6e)]: { label: "Temperature", unit: "°C", decode: (v) => (v.getInt16(0, true) === -32768 ? null : v.getInt16(0, true) / 100) },
  [uuid16(0x2a6f)]: { label: "Humidity", unit: "%", decode: (v) => (v.getUint16(0, true) === 0xffff ? null : v.getUint16(0, true) / 100) },
  [uuid16(0x2a6d)]: { label: "Pressure", unit: "hPa", decode: (v) => v.getUint32(0, true) / 1000 },
  [uuid16(0x2b8c)]: { label: "CO₂", unit: "ppm", decode: (v) => v.getUint16(0, true) },
  // PM characteristics are kg/m³ as SFLOAT; convert to µg/m³.
  [uuid16(0x2bd5)]: { label: "PM1", unit: "µg/m³", decode: (v) => scalePm(sfloat16(v.getUint16(0, true))) },
  [uuid16(0x2bd6)]: { label: "PM2.5", unit: "µg/m³", decode: (v) => scalePm(sfloat16(v.getUint16(0, true))) },
  [uuid16(0x2bd7)]: { label: "PM10", unit: "µg/m³", decode: (v) => scalePm(sfloat16(v.getUint16(0, true))) },
  [uuid16(0x2a19)]: { label: "Battery", unit: "%", decode: (v) => v.getUint8(0) },
  [uuid16(0x2a29)]: { label: "Manufacturer", unit: "", decode: text },
  [uuid16(0x2a24)]: { label: "Model", unit: "", decode: text },
};
function scalePm(kgm3: number | null) {
  return kgm3 === null ? null : Math.round(kgm3 * 1e9 * 10) / 10;
}

/* ---------------------------------- Store ---------------------------------- */
export interface BtReading {
  uuid: string;
  label: string;
  value: string;
  unit: string;
}
export interface BtWritable {
  uuid: string;
  service: string;
  serviceName: string;
}
export interface BtState {
  phase: "idle" | "requesting" | "connecting" | "connected" | "error";
  deviceName?: string;
  services: Array<{ uuid: string; name: string; characteristics: number }>;
  readings: BtReading[];
  writables: BtWritable[];
  target?: string;
  error?: string;
  lastSent?: { at: string; summary: string; ok: boolean; message?: string };
}

let state: BtState = { phase: "idle", services: [], readings: [], writables: [] };
const listeners = new Set<() => void>();
let device: BtDevice | null = null;
const chars = new Map<string, BtCharacteristic>();

function set(patch: Partial<BtState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
export const bluetoothStore = {
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  get: () => state,
  serverSnapshot: (): BtState => SERVER_STATE,
};
const SERVER_STATE: BtState = { phase: "idle", services: [], readings: [], writables: [] };

export function bluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator && typeof window !== "undefined" && window.isSecureContext;
}

const ERRORS: Record<string, string> = {
  NotFoundError: "No device was chosen.",
  SecurityError: "Bluetooth is blocked here. It needs https and, in some browsers, a flag or permission.",
  NotAllowedError: "Bluetooth permission was denied.",
  NetworkError: "The device disconnected or is out of range.",
  NotSupportedError: "That device or operation isn't supported over Web Bluetooth.",
};
const errMsg = (err: unknown) =>
  err instanceof DOMException ? (ERRORS[err.name] ?? err.message) : err instanceof Error ? err.message : "Bluetooth error";

export async function connectBluetooth(extraServiceUuid?: string) {
  if (!bluetoothSupported()) return;
  const optionalServices: Array<string | number> = [0x181a, 0x180f, 0x180a, NORDIC_UART.service];
  const extra = extraServiceUuid?.trim().toLowerCase();
  if (extra) optionalServices.push(/^[0-9a-f]{4}$/.test(extra) ? parseInt(extra, 16) : extra);
  set({ phase: "requesting", error: undefined });
  try {
    const nav = navigator as unknown as BtNavigator;
    device = await nav.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
    device.addEventListener("gattserverdisconnected", () => set({ phase: "idle", error: "Device disconnected." }));
    set({ phase: "connecting", deviceName: device.name || "Unnamed device" });
    const server = await device.gatt!.connect();
    await discover(server);
  } catch (err) {
    set({ phase: err instanceof DOMException && err.name === "NotFoundError" ? "idle" : "error", error: errMsg(err) });
  }
}

async function discover(server: BtServer) {
  chars.clear();
  const services: BtState["services"] = [];
  const writables: BtWritable[] = [];
  let primary: BtService[] = [];
  try {
    primary = await server.getPrimaryServices();
  } catch {
    primary = [];
  }
  for (const svc of primary) {
    let list: BtCharacteristic[] = [];
    try {
      list = await svc.getCharacteristics();
    } catch {
      /* some services refuse enumeration */
    }
    const name = SERVICE_NAMES[svc.uuid] ?? `Service ${svc.uuid.slice(4, 8) === "0000" ? svc.uuid : svc.uuid.slice(0, 8)}`;
    services.push({ uuid: svc.uuid, name, characteristics: list.length });
    for (const c of list) {
      chars.set(c.uuid, c);
      if (c.properties.write || c.properties.writeWithoutResponse) writables.push({ uuid: c.uuid, service: svc.uuid, serviceName: name });
    }
  }
  const target = writables.find((w) => w.uuid === NORDIC_UART.rx)?.uuid ?? writables[0]?.uuid;
  set({ phase: "connected", services, writables, target, error: undefined });
  await readSensors();
}

export async function readSensors() {
  const readings: BtReading[] = [];
  for (const [uuid, c] of chars) {
    const d = DECODERS[uuid];
    if (!d || !c.properties.read) continue;
    try {
      const v = d.decode(await c.readValue());
      if (v !== null && v !== "") readings.push({ uuid, label: d.label, unit: d.unit, value: typeof v === "number" ? String(Math.round(v * 10) / 10) : v });
    } catch {
      /* unreadable characteristic (permissions/encryption) */
    }
  }
  set({ readings });
}

export function chooseTarget(uuid: string | undefined) {
  set({ target: uuid });
}

export function disconnectBluetooth() {
  try {
    device?.gatt?.disconnect();
  } finally {
    device = null;
    chars.clear();
    set({ phase: "idle", services: [], readings: [], writables: [], target: undefined, deviceName: undefined, error: undefined });
  }
}

/** True when an approved command can be forwarded to a connected device. */
export function bridgeReady(): boolean {
  return state.phase === "connected" && Boolean(state.target && chars.get(state.target));
}

/** Encode an approved command as one JSON line, split into 20-byte BLE packets (default ATT MTU). */
export function encodeCommand(approvalId: string, command: DeviceCommand): Uint8Array[] {
  const line = JSON.stringify({ type: "airhealth.command", approvalId, command }) + "\n";
  const bytes = new TextEncoder().encode(line);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 20) out.push(bytes.slice(i, i + 20));
  return out;
}

/** Send an APPROVED command. Callers must only call this after the approval succeeded. */
export async function sendApprovedCommand(approvalId: string, command: DeviceCommand, summary: string): Promise<boolean> {
  const c = state.target ? chars.get(state.target) : undefined;
  if (!c) return false;
  try {
    for (const packet of encodeCommand(approvalId, command)) {
      const buf = packet as unknown as BufferSource;
      if (c.properties.writeWithoutResponse && c.writeValueWithoutResponse) await c.writeValueWithoutResponse(buf);
      else if (c.writeValueWithResponse) await c.writeValueWithResponse(buf);
      else await c.writeValue!(buf);
    }
    set({ lastSent: { at: new Date().toISOString(), summary, ok: true } });
    return true;
  } catch (err) {
    set({ lastSent: { at: new Date().toISOString(), summary, ok: false, message: errMsg(err) } });
    return false;
  }
}
