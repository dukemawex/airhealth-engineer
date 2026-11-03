/**
 * Test-only HTTP doubles. Nothing here is imported by app code: the app is
 * pointed at these servers purely through its base-URL environment variables.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
}

export type ChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export type ScriptReply =
  | { content?: string; toolCalls?: Array<{ name: string; args: unknown }> }
  | { status: number; error: { type: string; message: string }; headers?: Record<string, string> };

export async function startServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => unknown) {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => void handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let seq = 0;

/**
 * Scripted Muse Spark: speaks the Meta Model API Chat Completions wire format
 * (JSON and SSE `data:` chunks terminated by `[DONE]`, tool-call deltas by index).
 */
export async function startMockMuseSpark(script: (messages: ChatMessage[], body: Record<string, unknown>) => ScriptReply) {
  const requests: Recorded[] = [];
  const srv = await startServer((req, res, raw) => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    requests.push({ path: req.url ?? "", headers: req.headers, body });
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions") || !body) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "not_found", message: "no route" } }));
      return;
    }
    const out = script(body.messages as ChatMessage[], body);
    if ("status" in out) {
      res.writeHead(out.status, { "content-type": "application/json", ...out.headers }).end(JSON.stringify({ error: out.error }));
      return;
    }
    const id = `chatcmpl_mock_${++seq}`;
    const toolCalls = (out.toolCalls ?? []).map((t, i) => ({
      id: `call_mock_${seq}_${i}`,
      type: "function" as const,
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
    const finish = toolCalls.length ? "tool_calls" : "stop";
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta: unknown, finishReason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      send({ role: "assistant" });
      if (out.content) {
        // Split text into a few deltas, like a real stream.
        for (const piece of out.content.match(/.{1,24}/gs) ?? []) send({ content: piece });
      }
      toolCalls.forEach((tc, index) => {
        const args = tc.function.arguments;
        const mid = Math.floor(args.length / 2);
        send({ tool_calls: [{ index, id: tc.id, type: "function", function: { name: tc.function.name, arguments: args.slice(0, mid) } }] });
        send({ tool_calls: [{ index, function: { arguments: args.slice(mid) } }] });
      });
      send({}, finish);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: out.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            finish_reason: finish,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
  return { ...srv, requests };
}

/** Mock OpenAQ v3 + Open-Meteo geocoder on one server. `pm25` is read on every request. */
export async function startMockAirData(state: { pm25: number; geocodeFails?: boolean; openaqDown?: boolean; noStations?: boolean; modelUp?: boolean }) {
  const requests: Recorded[] = [];
  const srv = await startServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push({ path: url.pathname + url.search, headers: req.headers, body: null });
    const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (url.pathname === "/geo/search") {
      if (state.geocodeFails) return json(503, { error: true, reason: "unavailable" });
      return json(200, {
        results: [
          { name: url.searchParams.get("name"), latitude: 6.455, longitude: 3.394, country: "Testland", country_code: "TL", timezone: "Africa/Lagos" },
        ],
      });
    }
    if (url.pathname.startsWith("/openaq/")) {
      if (req.headers["x-api-key"] !== "openaq-test-key") return json(401, { detail: "bad key" });
      if (state.openaqDown) return json(503, { detail: "down" });
      if (url.pathname === "/openaq/locations") {
        if (state.noStations) return json(200, { results: [] });
        const [lat, lon] = (url.searchParams.get("coordinates") ?? "0,0").split(",").map(Number);
        return json(200, {
          results: [
            {
              id: 101,
              name: "Mock station",
              timezone: "Africa/Lagos",
              country: { code: "TL", name: "Testland" },
              coordinates: { latitude: lat! + 0.01, longitude: lon! + 0.01 },
              sensors: [
                { id: 1, parameter: { name: "pm25", units: "µg/m³", displayName: "PM2.5" } },
                { id: 2, parameter: { name: "pm10", units: "µg/m³", displayName: "PM10" } },
              ],
              datetimeLast: { utc: new Date().toISOString() },
            },
          ],
        });
      }
      if (url.pathname === "/openaq/locations/101/latest") {
        const now = new Date().toISOString();
        return json(200, {
          results: [
            { datetime: { utc: now }, value: state.pm25, sensorsId: 1, locationsId: 101 },
            { datetime: { utc: now }, value: state.pm25 * 1.6, sensorsId: 2, locationsId: 101 },
          ],
        });
      }
    }
    if (url.pathname === "/model/air-quality") {
      if (!state.modelUp) return json(503, { error: true });
      return json(200, {
        timezone: "Etc/GMT",
        current_units: { pm2_5: "μg/m³", pm10: "μg/m³" },
        current: { time: new Date().toISOString().slice(0, 16), pm2_5: state.pm25, pm10: state.pm25 * 2 },
      });
    }
    return json(404, { detail: "not found" });
  });
  return { ...srv, requests };
}

/** Parse an AI SDK UI message stream (SSE) into its chunks. */
export async function readUiStream(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}
