import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { logoSvg } from "@/components/brand/logoGeometry";
import { parseDecision } from "@/lib/agent/monitor";
import { combineStatus } from "@/lib/agent/status";
import { sessionToUIMessages, toNotice } from "@/lib/agent/uiStream";
import type { AirQualitySnapshot, Session } from "@/lib/domain";
import { AppError, UpstreamError } from "@/lib/errors";
import { readSse, StreamAccumulator } from "@/lib/meta/client";
import { pm25Category, pm25ToUsAqi } from "@/lib/services/aqi";

function sse(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      // Deliver in awkward slices to exercise buffering.
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
}

describe("Meta streaming", () => {
  it("parses SSE data events, stops at [DONE], and accumulates tool-call deltas by index", async () => {
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "muse-spark-1.3", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const body =
      ": keep-alive\n\n" +
      chunk({ role: "assistant", content: "Hel" }) +
      chunk({ content: "lo" }) +
      chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "getStatus", arguments: "{}" } }] }) +
      chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "getAirQuality", arguments: '{"ci' } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"X"}' } }] }) +
      chunk({}, "tool_calls") +
      "data: [DONE]\n\n" +
      chunk({ content: "ignored after DONE" });
    const acc = new StreamAccumulator();
    const deltas: string[] = [];
    for await (const ev of readSse(sse(body))) acc.push(ev, (d) => deltas.push(d));
    const res = acc.result();
    expect(deltas.join("")).toBe("Hello");
    expect(res.choices[0]!.message.content).toBe("Hello");
    expect(res.choices[0]!.finish_reason).toBe("tool_calls");
    expect(res.choices[0]!.message.tool_calls?.map((t) => [t.id, t.function.name, t.function.arguments])).toEqual([
      ["a", "getAirQuality", '{"city":"X"}'],
      ["b", "getStatus", "{}"],
    ]);
  });
});

describe("AQI", () => {
  it("uses the 2024 EPA PM2.5 breakpoints", () => {
    expect(pm25ToUsAqi(0)).toBe(0);
    expect(pm25ToUsAqi(9.0)).toBe(50);
    expect(pm25ToUsAqi(35.4)).toBe(100);
    expect(pm25ToUsAqi(42)).toBe(117);
    expect(pm25ToUsAqi(55.4)).toBe(150);
    expect(pm25ToUsAqi(999)).toBe(500);
    expect(pm25Category(9.1)).toBe("moderate");
    expect(pm25Category(35.5)).toBe("unhealthy_for_sensitive_groups");
  });
});

const snap = (pm25: number, source: AirQualitySnapshot["source"] = "openaq"): AirQualitySnapshot => ({
  location: { latitude: 1, longitude: 2, name: "Somewhere", source: "geocoded" } as AirQualitySnapshot["location"],
  source,
  sourceNote: "",
  fetchedAt: new Date().toISOString(),
  readings: [{ parameter: "pm25", value: pm25, units: "µg/m³" }],
});
const baseSession = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  createdAt: "",
  updatedAt: "",
  status: "idle",
  messages: [],
  ...over,
} as Session);
const counts = { activeInterventions: 0, proposedInterventions: 0, pendingApprovals: 0, executedActions: 0 };

describe("combined status", () => {
  it("is unknown with no data and drives journey steps from real state only", () => {
    const c = combineStatus({ session: baseSession(), ...counts });
    expect(c.level).toBe("unknown");
    expect(c.steps.every((s) => !s.done)).toBe(true);
  });
  it("uses the sensitive-group threshold for asthma", () => {
    const session = baseSession({ profile: { conditions: ["asthma"], symptoms: [] } });
    expect(combineStatus({ session, aq: snap(20), ...counts }).level).toBe("act");
    expect(combineStatus({ session: baseSession(), aq: snap(20), ...counts }).level).toBe("watch");
    expect(combineStatus({ session: baseSession(), aq: snap(5), ...counts }).level).toBe("ok");
  });
  it("escalates to urgent on red-flag symptoms and notes modelled data", () => {
    const session = baseSession({ profile: { conditions: [], symptoms: ["chest pain"] } });
    const c = combineStatus({ session, aq: snap(5, "open-meteo-cams-model"), ...counts, pendingApprovals: 1 });
    expect(c.level).toBe("urgent");
    expect(c.reasons.join(" ")).toMatch(/modelled/);
    expect(c.reasons.join(" ")).toMatch(/awaiting your approval/);
  });
});

describe("monitoring decision parsing", () => {
  it("extracts a JSON decision from model text and rejects junk", () => {
    expect(parseDecision('Sure: {"notify": true, "severity": "act", "message": "PM2.5 doubled."}')).toEqual({
      notify: true,
      severity: "act",
      message: "PM2.5 doubled.",
    });
    expect(parseDecision("no json here")).toBeNull();
    expect(parseDecision('{"notify": "yes"}')).toBeNull();
    expect(parseDecision(null)).toBeNull();
  });
});

describe("UI stream helpers", () => {
  it("maps errors to friendly notices without internals", () => {
    const rate = toNotice(new UpstreamError({ service: "meta-model-api", status: 429, message: "x", retryable: true }));
    expect(rate).toMatchObject({ code: "meta_rate_limited", retryable: true });
    expect(toNotice(new AppError("config_missing", "MODEL_API_KEY is not set")).message).toContain("MODEL_API_KEY");
    const internal = toNotice(new Error("stack trace with secrets"));
    expect(internal.message).not.toContain("secrets");
  });

  it("rebuilds UI messages from a stored session, grouping runs and monitoring updates", () => {
    const session = baseSession({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "getStatus", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
        { role: "assistant", content: "All good." },
        { role: "assistant", content: "**Monitoring update** (info): steady." },
      ] as Session["messages"],
    });
    const ui = sessionToUIMessages(session, []);
    expect(ui.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    const tool = ui[1]!.parts.find((p) => p.type === "dynamic-tool") as { state: string; output: unknown };
    expect(tool.state).toBe("output-available");
    expect(tool.output).toEqual({ ok: true });
    expect(ui[2]!.parts.some((p) => p.type === "text" && p.text.startsWith("**Monitoring update**"))).toBe(true);
  });
});

describe("logo single source of truth", () => {
  it("app/icon.svg and docs/logo/final.svg match the geometry (run `npm run logo` after edits)", () => {
    const root = join(__dirname, "..");
    expect(readFileSync(join(root, "src/app/icon.svg"), "utf8")).toBe(logoSvg());
    expect(readFileSync(join(root, "docs/logo/final.svg"), "utf8")).toBe(logoSvg());
  });
});
