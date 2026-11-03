import { describe, expect, it } from "vitest";
import { assessHealth } from "@/lib/agent/tools/getHealthContext";
import { getAirQualityTool } from "@/lib/agent/tools/getAirQuality";
import { planForecastTool } from "@/lib/agent/tools/planForecast";
import { requestLocationTool } from "@/lib/agent/tools/requestLocation";
import { TOOLS } from "@/lib/agent/tools";
import { buildDeveloperPrompt } from "@/lib/agent/prompt";
import { cleanReplyBlocks, dedupePreambles, fixQuestionMarks, sentenceSimilarity } from "@/lib/agent/replyCopy";
import { bestOutdoorWindow } from "@/lib/forecast/outdoorWindow";
import { locationIntent, shouldLocateBeforeSend } from "@/lib/client/locationIntent";
import { detectPlatform, geoHelp } from "@/lib/client/geolocation";
import { STARTER_PROMPTS } from "@/lib/healthChips";
import { parseConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import type { Session } from "@/lib/domain";

const logger = createLogger({ test: true });
const noLocCtx = () =>
  ({
    session: { id: "s1", createdAt: "", updatedAt: "", messages: [] },
    config: parseConfig({ MODEL_API_KEY: "LLM_test" }),
    fetchImpl: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    logger,
    httpTimeoutMs: 1000,
    getDeviceAdapter: () => ({ name: "sandbox", execute: async () => ({}), getStates: async () => [] }),
  }) as never;

describe("location dead end", () => {
  it("registers a requestLocation UI tool that needs no approval", async () => {
    expect(TOOLS.map((t) => t.name)).toContain("requestLocation");
    expect(requestLocationTool.requiresApproval).toBe(false);
    const out = (await requestLocationTool.execute!({ reason: "to find your best time to exercise" }, noLocCtx())) as Record<string, unknown>;
    expect(out).toMatchObject({ needsLocation: true, reason: "to find your best time to exercise" });
  });

  it("reports a location already on file instead of asking again", async () => {
    const ctx = noLocCtx() as unknown as { session: Session };
    ctx.session.location = { latitude: 8.4966, longitude: 4.5421, name: "Ilorin", country: "Nigeria", source: "user_coordinates" } as Session["location"];
    const out = (await requestLocationTool.execute!({ reason: "x" }, ctx as never)) as Record<string, unknown>;
    expect(out.alreadyKnown).toBe(true);
    expect(String(out.place)).toContain("Ilorin");
  });

  it("getAirQuality and planForecast return needsLocation (not a raw error) and point at requestLocation", async () => {
    const aq = (await getAirQualityTool.execute!({ radiusMeters: 15000 }, noLocCtx())) as Record<string, unknown>;
    expect(aq.needsLocation).toBe(true);
    expect(String(aq.error)).toMatch(/requestLocation/);
    expect(String(aq.error)).not.toMatch(/Ask the user for a city or coordinates/);
    const pf = (await planForecastTool.execute!({ horizonHours: 72 }, noLocCtx())) as Record<string, unknown>;
    expect(pf.needsLocation).toBe(true);
    expect(String(pf.error)).toMatch(/requestLocation/);
  });

  it("the prompt tells the model to call requestLocation and to end exercise answers with the best window", () => {
    const p = buildDeveloperPrompt({ id: "s", messages: [] } as unknown as Session, new Date(), "sandbox");
    expect(p).toMatch(/call requestLocation/);
    expect(p).toMatch(/never ask for latitude\/longitude in text/i);
    expect(p).toMatch(/Best window/);
    expect(p).not.toMatch(/combine them into that one question/);
  });

  it("detects 'use my location' intent on the client", () => {
    expect(locationIntent("Access my location via my device")).toBe("explicit");
    expect(locationIntent("use my current location")).toBe("explicit");
    expect(locationIntent("check my device location please")).toBe("explicit");
    expect(locationIntent("is it ok to run where I am?")).toBe("implicit");
    expect(locationIntent("set up the purifier for tonight")).toBeNull();
    expect(shouldLocateBeforeSend("Access my location via my device", true)).toBe(true);
    expect(shouldLocateBeforeSend("how is the air where I am", true)).toBe(false);
    expect(shouldLocateBeforeSend("how is the air where I am", false)).toBe(true);
  });

  it("location-dependent quick starts ask the device first", () => {
    const byId = Object.fromEntries(STARTER_PROMPTS.map((p) => [p.id, p]));
    expect(byId["check-now"]?.useLocation).toBe(true);
    expect(byId.commute?.useLocation).toBe(true);
    expect(byId.outdoors?.useLocation).toBe(true);
    expect(byId.purifier?.useLocation).toBeFalsy();
  });

  it("explains denied / timeout / insecure with iOS and Android steps", () => {
    const ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
    expect(detectPlatform(ios, 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 5)).toBe("ios"); // iPadOS desktop UA
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130", 5)).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) Chrome/130", 0)).toBe("other");
    const denied = geoHelp("denied", "ios");
    expect(denied.message).toMatch(/blocked/);
    expect(denied.hint).toMatch(/Settings → Privacy & Security → Location Services/);
    expect(denied.hint).toMatch(/Website Settings → Location → Allow/);
    expect(geoHelp("denied", "android").hint).toMatch(/Permissions → Location/);
    expect(geoHelp("insecure", "ios").hint).toMatch(/https/);
    expect(geoHelp("timeout", "ios").hint).toMatch(/Wi-Fi/);
  });
});

describe("respiratory symptoms tighten targets", () => {
  it("wheezing alone puts the user in the respiratory sensitive group", () => {
    const a = assessHealth({ conditions: [], symptoms: ["wheezing"] });
    expect(a.sensitiveGroup).toBe(true);
    expect(a.group).toBe("respiratory");
    expect(a.actionThresholdPm25).toBe(9);
    expect(a.sensitivityReasons.join()).toMatch(/respiratory symptoms: wheezing/);
    expect(a.urgentCareAdvised).toBe(false);
  });
  it.each(["coughing", "shortness of breath", "tight chest", "breathless when walking"])("%s is respiratory", (s) => {
    expect(assessHealth({ conditions: [], symptoms: [s] }).group).toBe("respiratory");
  });
  it("severe shortness of breath stays a red flag", () => {
    const a = assessHealth({ conditions: [], symptoms: ["severe shortness of breath"] });
    expect(a.urgentCareAdvised).toBe(true);
  });
  it("unrelated symptoms keep the general population threshold", () => {
    const a = assessHealth({ conditions: [], symptoms: ["tired"] });
    expect(a.sensitiveGroup).toBe(false);
    expect(a.group).toBe("general");
    expect(a.actionThresholdPm25).toBe(35.4);
  });
});

describe("reply copy", () => {
  it("drops a repeated preamble across steps of one reply", () => {
    const blocks = [
      "I'll use your device location to check the air quality where you are right now.",
      "I'll use your device location to check the current air quality where you are.",
      "## Air now\nPM2.5 is 41 µg/m³.",
    ];
    const out = dedupePreambles(blocks);
    expect(out[0]).toMatch(/device location/);
    expect(out[1]).toBe("");
    expect(out[2]).toContain("PM2.5 is 41");
  });
  it("keeps distinct sentences and structured lines", () => {
    const out = dedupePreambles(["Checking the air in Ilorin.", "Now planning the next 72 hours.", "- Close windows\n- Close windows"]);
    expect(out).toEqual(["Checking the air in Ilorin.", "Now planning the next 72 hours.", "- Close windows\n- Close windows"]);
    expect(sentenceSimilarity("Checking the air in Ilorin.", "Now planning the next 72 hours.")).toBeLessThan(0.6);
  });
  it("ends interrogative sentences with a question mark", () => {
    expect(fixQuestionMarks("Which city are you in.")).toBe("Which city are you in?");
    expect(fixQuestionMarks("**Any sensitivity to tune for (asthma, a baby at home)**.")).toBe("**Any sensitivity to tune for (asthma, a baby at home)?**");
    expect(fixQuestionMarks("Do you have a purifier")).toBe("Do you have a purifier?");
    expect(fixQuestionMarks("Do not open the windows.")).toBe("Do not open the windows.");
    expect(fixQuestionMarks("When PM2.5 rises, close the windows.")).toBe("When PM2.5 rises, close the windows.");
    expect(fixQuestionMarks("- Is anyone at home sensitive.")).toBe("- Is anyone at home sensitive?");
  });
  it("cleanReplyBlocks combines profile dedupe, preamble dedupe and question marks", () => {
    const out = cleanReplyBlocks(["Let me check the air where you are now.", "Let me check the air where you are now.", "Done. Which city are you in."]);
    expect(out).toEqual(["Let me check the air where you are now.", "", "Done. Which city are you in?"]);
  });
});

describe("best outdoor window", () => {
  const series = (start: string, values: number[]) => {
    const t0 = new Date(`${start}:00Z`).getTime();
    return values.map((pm25, i) => ({ t: new Date(t0 + i * 3600_000).toISOString().slice(0, 16), pm25 }));
  };
  it("picks the cleanest daylight block today", () => {
    // 05:00 onwards: dirty at night, clean 07-09, moderate afterwards.
    const vals = [60, 40, 10, 11, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 70, 70, 70, 70, 70];
    const w = bestOutdoorWindow(series("2026-11-03T05:00", vals), { thresholdPm25: 35.4 })!;
    expect(w.startLocal).toBe("2026-11-03T07:00");
    expect(w.endLocal).toBe("2026-11-03T09:00");
    expect(w.day).toBe("today");
    expect(w.withinThreshold).toBe(true);
    expect(w.summary).toBe("Best window: today 07:00–09:00 (PM2.5 ~11 µg/m³, forecast)");
  });
  it("moves to tomorrow when nothing today is under a sensitive threshold", () => {
    const today = Array.from({ length: 9 }, () => 25); // 15:00-23:00
    const night = Array.from({ length: 7 }, () => 50); // 00:00-06:00
    const tomorrow = [8, 7, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20];
    const w = bestOutdoorWindow(series("2026-11-03T15:00", [...today, ...night, ...tomorrow]), { thresholdPm25: 9 })!;
    expect(w.day).toBe("tomorrow");
    expect(w.startLocal).toBe("2026-11-04T07:00");
    expect(w.withinThreshold).toBe(true);
  });
  it("says so when even the best window is above the threshold", () => {
    const w = bestOutdoorWindow(series("2026-11-03T06:00", Array.from({ length: 14 }, (_, i) => 40 + i)), { thresholdPm25: 9 })!;
    expect(w.withinThreshold).toBe(false);
    expect(w.summary).toMatch(/still above your 9 µg\/m³ threshold/);
  });
  it("returns null without daylight hours", () => {
    expect(bestOutdoorWindow([], {})).toBeNull();
    expect(bestOutdoorWindow(series("2026-11-03T21:00", [5, 5, 5, 5, 5]), { maxDays: 1 })).toBeNull();
  });
});
