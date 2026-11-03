"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch } from "@/lib/client/api";

type Provider = "shelly_local" | "shelly_cloud" | "homeassistant";

export interface PlugInfo {
  connected: boolean;
  source: "session" | "env" | null;
  provider: Provider | null;
  label: string | null;
  baseAdapter: string;
  homeAssistantAvailable: boolean;
}

interface CheckResult {
  reachable: boolean;
  online: boolean;
  on: boolean | null;
  message: string;
}

const PROVIDERS: Array<{ id: Provider; name: string; hint: string }> = [
  { id: "shelly_cloud", name: "Shelly Cloud", hint: "Works from anywhere. Shelly app → Settings → Authorization cloud key gives the server and key; Device → Settings → Device information gives the Device Id." },
  { id: "shelly_local", name: "Shelly (local network)", hint: "Gen2/Gen3 plug's LAN address. Only works when this app runs on the same Wi-Fi as the plug (e.g. npm start at home)." },
  { id: "homeassistant", name: "Home Assistant switch", hint: "A switch.* entity. Uses the server's HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN." },
];

/**
 * Smart plug for the purifier. Saving or checking never switches the plug:
 * on/off only happens after you approve an action in the chat.
 */
export function SmartPlugPanel({ conversationId }: { conversationId: string | null }) {
  const [info, setInfo] = useState<PlugInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<Provider>("shelly_cloud");
  const [host, setHost] = useState("");
  const [server, setServer] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [channel, setChannel] = useState("0");
  const [entityId, setEntityId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const base = conversationId ? `/api/sessions/${encodeURIComponent(conversationId)}/plug` : "/api/plug";

  const load = useCallback(async () => {
    try {
      setInfo(await apiFetch<PlugInfo>(base, { cache: "no-store" }));
    } catch {
      setInfo(null);
    }
  }, [base]);

  useEffect(() => {
    let live = true;
    apiFetch<PlugInfo>(base, { cache: "no-store" })
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [base]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!conversationId) return;
    const ch = Math.max(0, Math.min(7, Number.parseInt(channel, 10) || 0));
    const body =
      provider === "shelly_local"
        ? { provider, host, switchId: ch }
        : provider === "shelly_cloud"
          ? { provider, server, deviceId, channel: ch, authKey }
          : { provider, entityId };
    setBusy(true);
    setNote(null);
    try {
      setInfo(await apiFetch<PlugInfo>(base, { method: "PUT", body: JSON.stringify(body) }));
      setAuthKey("");
      setEditing(false);
      setNote({ tone: "ok", text: "Saved. Nothing was switched: purifier on/off now goes to this plug after you approve it." });
    } catch (err) {
      setNote({ tone: "error", text: err instanceof ApiError ? err.message : "Couldn't save the plug." });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setNote(null);
    try {
      setInfo(await apiFetch<PlugInfo>(base, { method: "DELETE" }));
    } catch (err) {
      setNote({ tone: "error", text: err instanceof ApiError ? err.message : "Couldn't remove the plug." });
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (!conversationId) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await apiFetch<CheckResult>(base, { method: "POST", body: JSON.stringify({ check: true }) });
      setNote({ tone: r.reachable && r.online ? "ok" : "error", text: r.message });
    } catch (err) {
      setNote({ tone: "error", text: err instanceof ApiError ? err.message : "Check failed." });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const hint = PROVIDERS.find((p) => p.id === provider)?.hint;

  return (
    <div className="panel plug-panel" data-connected={info?.connected ? "true" : "false"}>
      <div className="bt-head">
        <span className={info?.connected ? "bt-dot" : "plug-dot-off"} aria-hidden="true" />
        <strong>Smart plug</strong>
        <span className="plug-badge">{info?.connected ? (info.source === "env" ? "Server plug" : "Connected") : "No plug connected"}</span>
      </div>
      {info?.connected ? (
        <p className="card-sub">
          {info.label}. Approved purifier on/off actions switch this plug; speed and mode stay on the purifier.
        </p>
      ) : (
        <p className="card-sub">
          Purifier on/off actions run in the sandbox (simulated, nothing switched) until you connect a Shelly or Home Assistant plug.
        </p>
      )}

      {note && (
        <p className="plug-note" data-tone={note.tone} role="status">
          {note.text}
        </p>
      )}

      {!conversationId ? (
        <p className="card-sub">Start a conversation to connect a plug to it.</p>
      ) : editing ? (
        <form className="plug-form" onSubmit={save}>
          <div className="field">
            <label htmlFor="plug-provider">Plug</label>
            <select id="plug-provider" className="input" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id} disabled={p.id === "homeassistant" && !info?.homeAssistantAvailable}>
                  {p.name}
                  {p.id === "homeassistant" && !info?.homeAssistantAvailable ? " (server not set up)" : ""}
                </option>
              ))}
            </select>
            {hint && <span className="hint">{hint}</span>}
          </div>
          {provider === "shelly_local" && (
            <div className="field">
              <label htmlFor="plug-host">Plug IP address</label>
              <input id="plug-host" className="input" placeholder="192.168.1.50" value={host} onChange={(e) => setHost(e.target.value)} required />
            </div>
          )}
          {provider === "shelly_cloud" && (
            <>
              <div className="field">
                <label htmlFor="plug-server">Cloud server</label>
                <input id="plug-server" className="input" placeholder="shelly-42-eu.shelly.cloud" value={server} onChange={(e) => setServer(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="plug-device">Device Id</label>
                <input id="plug-device" className="input" placeholder="a8032ab1c2d3" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="plug-key">Authorization cloud key</label>
                <input
                  id="plug-key"
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={authKey}
                  onChange={(e) => setAuthKey(e.target.value)}
                  required
                />
                <span className="hint">Stored server-side with this conversation and never shown again.</span>
              </div>
            </>
          )}
          {provider === "homeassistant" && (
            <div className="field">
              <label htmlFor="plug-entity">Switch entity</label>
              <input id="plug-entity" className="input" placeholder="switch.purifier_plug" value={entityId} onChange={(e) => setEntityId(e.target.value)} required />
            </div>
          )}
          {provider !== "homeassistant" && (
            <div className="field">
              <label htmlFor="plug-channel">Switch channel</label>
              <input id="plug-channel" className="input" inputMode="numeric" value={channel} onChange={(e) => setChannel(e.target.value)} />
            </div>
          )}
          <div className="actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              Save plug
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)} disabled={busy}>
            {info?.source === "session" ? "Change plug" : "Connect a plug"}
          </button>
          {info?.connected && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void check()} disabled={busy}>
              Check connection
            </button>
          )}
          {info?.source === "session" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove()} disabled={busy}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
