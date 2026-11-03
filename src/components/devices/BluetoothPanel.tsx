"use client";

import { useState, useSyncExternalStore } from "react";
import {
  bluetoothStore,
  bluetoothSupported,
  chooseTarget,
  connectBluetooth,
  disconnectBluetooth,
  readSensors,
} from "@/lib/client/bluetooth";
import { fmtTime } from "../format";

const noop = () => () => undefined;

/** Nearby devices over Web Bluetooth. Approved commands are forwarded by AgentApp, never from here. */
export function BluetoothPanel({ onShareReadings, canShare }: { onShareReadings: (text: string) => void; canShare: boolean }) {
  const supported = useSyncExternalStore(noop, bluetoothSupported, () => false);
  const bt = useSyncExternalStore(bluetoothStore.subscribe, bluetoothStore.get, bluetoothStore.serverSnapshot);
  const [customService, setCustomService] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const busy = bt.phase === "requesting" || bt.phase === "connecting";

  const honest = (
    <p className="card-sub">
      Most air conditioners, purifiers and fans use infrared remotes or a vendor Wi-Fi app, which a web page can&apos;t reach. Bluetooth
      works for BLE air sensors and for bridge devices (e.g. an ESP32 with an IR blaster) that accept JSON commands.
    </p>
  );

  if (!supported) {
    return (
      <div className="panel">
        <p className="panel-lede">Bluetooth isn&apos;t available in this browser.</p>
        <p className="card-sub">Use Chrome or Edge on desktop or Android, over https. Approved actions still run through the configured device adapter.</p>
        {honest}
      </div>
    );
  }

  const share = () => {
    const parts = bt.readings.filter((r) => r.unit).map((r) => `${r.label} ${r.value}${r.unit === "%" ? "%" : ` ${r.unit}`}`);
    if (parts.length) onShareReadings(`My indoor Bluetooth sensor (${bt.deviceName}) currently reads: ${parts.join(", ")}. Factor this into my plan.`);
  };

  return (
    <div className="panel bt-panel" data-phase={bt.phase}>
      {bt.phase === "connected" ? (
        <>
          <div className="bt-head">
            <span className="bt-dot" aria-hidden="true" />
            <strong>{bt.deviceName}</strong>
            <button type="button" className="btn btn-ghost btn-sm" onClick={disconnectBluetooth}>
              Disconnect
            </button>
          </div>
          {bt.readings.length > 0 ? (
            <dl className="bt-readings">
              {bt.readings.map((r) => (
                <div key={r.uuid}>
                  <dt>{r.label}</dt>
                  <dd>
                    {r.value}
                    {r.unit && <span className="card-sub"> {r.unit}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="card-sub">No standard Environmental Sensing readings on this device.</p>
          )}
          <div className="actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void readSensors()}>
              Refresh readings
            </button>
            {bt.readings.some((r) => r.unit && r.label !== "Battery") && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={share} disabled={!canShare}>
                Share with Muse Spark
              </button>
            )}
          </div>
          <details className="bt-services">
            <summary>
              {bt.services.length} service{bt.services.length === 1 ? "" : "s"} discovered
            </summary>
            <ul className="list">
              {bt.services.map((s) => (
                <li key={s.uuid}>
                  {s.name} · {s.characteristics} characteristic{s.characteristics === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          </details>
          {bt.writables.length > 0 ? (
            <div className="field">
              <label htmlFor="bt-target">Send approved commands to</label>
              <select id="bt-target" className="input" value={bt.target ?? ""} onChange={(e) => chooseTarget(e.target.value || undefined)}>
                <option value="">Don&apos;t send (readings only)</option>
                {bt.writables.map((w) => (
                  <option key={w.uuid} value={w.uuid}>
                    {w.serviceName} · {w.uuid.slice(0, 8)}
                  </option>
                ))}
              </select>
              <span className="hint">
                Only after you approve an action. It&apos;s written as one JSON line; your device must understand it.
              </span>
            </div>
          ) : (
            <p className="card-sub">This device exposes no writable characteristic we can reach, so it&apos;s read-only here.</p>
          )}
          {bt.lastSent && (
            <p className="card-sub" role="status">
              {bt.lastSent.ok ? "Sent" : "Couldn't send"} “{bt.lastSent.summary}” at {fmtTime(bt.lastSent.at, true)}
              {bt.lastSent.message ? `: ${bt.lastSent.message}` : "."}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="panel-lede">Connect a nearby Bluetooth air sensor or bridge.</p>
          <div className="actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void connectBluetooth(customService)} disabled={busy}>
              {bt.phase === "requesting" ? "Choose a device…" : bt.phase === "connecting" ? "Connecting…" : "Connect device"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
              Advanced
            </button>
          </div>
          {showAdvanced && (
            <div className="field">
              <label htmlFor="bt-service">Extra service UUID (optional)</label>
              <input
                id="bt-service"
                className="input"
                value={customService}
                onChange={(e) => setCustomService(e.target.value)}
                placeholder="e.g. 181a or a 128-bit UUID"
                spellCheck={false}
                autoComplete="off"
              />
              <span className="hint">Browsers only reveal services you name up front. Standard sensing, battery and UART are included.</span>
            </div>
          )}
          {bt.error && (
            <p className="card-sub" role="alert" data-tone="error">
              {bt.error}
            </p>
          )}
        </>
      )}
      {honest}
    </div>
  );
}
