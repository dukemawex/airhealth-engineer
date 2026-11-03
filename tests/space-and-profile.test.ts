import { describe, expect, it } from "vitest";
import { adaptDesignForSpace, computeChecks, designInterventionTool, resolveSpace } from "@/lib/agent/tools/designIntervention";
import { asksForProfile, dedupeProfileAsks, isProfileAsk, previousReplyAsked } from "@/lib/agent/profileAsk";
import { buildDeveloperPrompt } from "@/lib/agent/prompt";
import { exposureStepsOf, planView } from "@/components/cards/InterventionPlanCard";
import { InterventionDesignSchema, type InterventionDesign, type Session } from "@/lib/domain";
import { adaptPlanForSpace, plannerPrompt, rulesPlan } from "@/lib/forecast/plan";
import { spaceFromSetting } from "@/lib/space";
import { MemoryStateStore } from "@/lib/storage/memory";
import { minimalDesign, reply, setup, toolCall } from "./helpers";

const indoorPlan = () =>
  InterventionDesignSchema.parse({
    ...minimalDesign,
    exposureSteps: ["Cook with the lid on"],
    filtration: { recommendedFilterClass: "HEPA_H13", targetAirChangesPerHour: 5, purifierFanSetting: "high" },
    ventilation: {
      strategy: "natural_when_clean",
      schedule: [
        { start: "06:00", end: "08:00", mode: "windows_open", rationale: "cleanest hours" },
        { start: "18:00", end: "22:00", mode: "closed_recirculate", rationale: "evening smoke" },
      ],
    },
    deviceCommands: [
      { deviceType: "air_purifier", deviceId: "fan.p", action: "turn_on" },
      { deviceType: "window", deviceId: "cover.w", action: "close" },
    ],
  });

const session = (setting?: string) =>
  ({
    id: "ses_x",
    messages: [],
    scene: setting ? { capturedAt: "2026-11-03T10:00:00Z", analysis: { setting } } : undefined,
    lastAirQuality: {
      location: { latitude: 8.3, longitude: 4.5, source: "user_coordinates" },
      source: "cams",
      sourceNote: "",
      fetchedAt: new Date().toISOString(),
      readings: [{ parameter: "pm25", value: 40, units: "µg/m³" }],
    },
  }) as unknown as Session;

describe("exposure steps wording", () => {
  it("the plan schema uses exposureSteps, not healthPrecautions", () => {
    const d = indoorPlan();
    expect(d.exposureSteps).toEqual(["Cook with the lid on"]);
    expect("healthPrecautions" in d).toBe(false);
    expect(InterventionDesignSchema.parse(minimalDesign).exposureSteps).toEqual([]);
    const json = JSON.stringify(InterventionDesignSchema.toJSONSchema?.() ?? {});
    expect(json).not.toMatch(/healthPrecautions/);
  });

  it("legacy stored plans still render their steps", () => {
    expect(exposureStepsOf({ healthPrecautions: ["Old step"] } as unknown as InterventionDesign)).toEqual(["Old step"]);
    expect(exposureStepsOf({ exposureSteps: ["New"] })).toEqual(["New"]);
  });

  it("the system prompt says exposure steps, never health precautions", () => {
    const p = buildDeveloperPrompt({ id: "s", messages: [] } as unknown as Session, new Date(), "sandbox");
    expect(p).toMatch(/exposure steps/);
    expect(p).toMatch(/never call them 'health precautions'/);
  });
});

describe("space-aware plans", () => {
  it("maps photo settings to spaces", () => {
    expect(spaceFromSetting("semi_open")).toBe("semi_open");
    expect(spaceFromSetting("outdoor")).toBe("outdoor");
    expect(spaceFromSetting("window_view")).toBe("indoor");
    expect(spaceFromSetting(undefined)).toBeUndefined();
    expect(resolveSpace({}, session("semi_open"))).toBe("semi_open");
    expect(resolveSpace({ space: "outdoor" }, session("indoor"))).toBe("outdoor");
    expect(resolveSpace({}, session())).toBe("indoor");
  });

  it("strips indoor-only items for an open-sided cooking shelter", () => {
    const { design, removed } = adaptDesignForSpace(indoorPlan(), "semi_open");
    expect(design.ventilation.schedule.map((s) => s.mode)).toEqual(["open_dispersion"]);
    expect(design.ventilation.strategy).toBe("open_air_dispersion");
    expect(design.deviceCommands).toEqual([]);
    expect(design.filtration.targetAirChangesPerHour).toBeUndefined();
    expect(design.room).toBeUndefined();
    expect(removed.length).toBeGreaterThan(0);
  });

  it("returns no CADR/ACH outdoors, with a not-applicable note", () => {
    const { design } = adaptDesignForSpace(indoorPlan(), "outdoor");
    const checks = computeChecks(design, session("outdoor"), "outdoor");
    expect(checks.space).toBe("outdoor");
    expect(checks.requiredCadrM3h).toBeUndefined();
    expect(checks.targetAirChangesPerHour).toBeUndefined();
    expect(checks.roomVolumeM3).toBeUndefined();
    expect(checks.notApplicable?.[0]).toMatch(/Not applicable outdoors/);
  });

  it("leaves indoor plans unchanged", () => {
    const d = indoorPlan();
    const { design, removed } = adaptDesignForSpace(d, "indoor");
    expect(design).toEqual({ ...d, space: "indoor" });
    expect(removed).toEqual([]);
    const checks = computeChecks(design, session("indoor"), "indoor");
    expect(checks.requiredCadrM3h).toBe(150);
    expect(checks.space).toBe("indoor");
  });

  it("the tool enforces the space from the photo even if the model sends an indoor plan", async () => {
    const store = new MemoryStateStore();
    const out = (await designInterventionTool.execute!(indoorPlan(), { session: session("semi_open"), store } as never)) as {
      space: string;
      design: InterventionDesign;
      checks: { requiredCadrM3h?: number; warnings: string[] };
    };
    expect(out.space).toBe("semi_open");
    expect(out.design.deviceCommands).toEqual([]);
    expect(out.design.ventilation.schedule.every((s) => s.mode !== "windows_open")).toBe(true);
    expect(out.checks.requiredCadrM3h).toBeUndefined();
    expect(out.checks.warnings.some((w) => /removed indoor-only items/.test(w))).toBe(true);
  });

  it("the card hides indoor sections for open spaces, even for older stored plans", () => {
    const v = planView(indoorPlan(), { space: "outdoor", warnings: [] } as never);
    expect(v.showSizing).toBe(false);
    expect(v.notApplicable).toMatch(/Not applicable outdoors/);
    expect(v.schedule.map((s) => s.mode)).toEqual(["open_dispersion"]);
    expect(v.deviceCommands).toEqual([]);
    expect(v.exposureSteps).toEqual(["Cook with the lid on"]);
    const indoor = planView(indoorPlan(), { space: "indoor", warnings: [] } as never);
    expect(indoor.showSizing).toBe(true);
    expect(indoor.schedule).toHaveLength(2);
  });

  it("forecast plans drop window/purifier commands for open spaces", () => {
    const windows = [
      { startLocal: "a", endLocal: "b", avgPm25: 8, maxPm25: 10, maxUsAqi: 40, category: "moderate" },
      { startLocal: "b", endLocal: "c", avgPm25: 50, maxPm25: 60, maxUsAqi: 150, category: "unhealthy" },
    ] as never;
    const open = rulesPlan(windows, undefined, undefined, "semi_open");
    expect(open.steps.every((s) => s.command === null)).toBe(true);
    expect(open.steps.map((s) => s.title).join(" ")).toMatch(/upwind/i);
    const indoor = rulesPlan(windows);
    expect(indoor.steps.some((s) => s.command !== null)).toBe(true);
    const adapted = adaptPlanForSpace(indoor, "outdoor");
    expect(adapted.steps.every((s) => s.command === null)).toBe(true);
    expect(adaptPlanForSpace(indoor, "indoor")).toBe(indoor);
  });

  it("the forecast planner prompt forbids windows/HVAC for open spaces", () => {
    const base = { forecast: { hours: [], timezone: "Africa/Lagos", location: { name: "Awterere", latitude: 8.3, longitude: 4.5 } }, windows: [], sensitivity: "general", devices: [], room: null };
    const p = plannerPrompt({ ...base, space: "semi_open" } as never);
    expect(plannerPrompt(base as never)).not.toMatch(/open-sided/i);
    expect(p).toMatch(/open-sided|outdoor/i);
  });
});

describe("sensitivity profile asked once", () => {
  const ASK = "Does anyone at home have asthma or another sensitivity?";

  it("recognises asks but not statements", () => {
    expect(isProfileAsk(ASK)).toBe(true);
    expect(isProfileAsk("Share your sensitivity profile to tune the targets.")).toBe(true);
    expect(isProfileAsk("Your sensitivity profile is recorded.")).toBe(false);
    expect(isProfileAsk("Should I close the window now?")).toBe(false);
  });

  it("keeps only the last ask across the blocks of one reply", () => {
    const blocks = [
      `Checking the air now. ${ASK}`,
      `### Plan\n- Cook upwind\n\n### One question\n${ASK}`,
      `## Summary\nPM2.5 is 40 µg/m³ (modelled).\n\n${ASK}`,
    ];
    const out = dedupeProfileAsks(blocks);
    expect(out.filter(asksForProfile)).toHaveLength(1);
    expect(asksForProfile(out[2])).toBe(true);
    expect(out[0]).toBe("Checking the air now.");
    expect(out[1]).not.toMatch(/One question/);
    expect(out[1]).toMatch(/Cook upwind/);
  });

  it("removes every ask when the previous reply already asked", () => {
    const out = dedupeProfileAsks([`Plan ready. ${ASK}`], { alreadyAsked: true });
    expect(out).toEqual(["Plan ready."]);
  });

  it("detects whether the previous reply asked", () => {
    const msgs = [
      { role: "user", text: "Air in Awterere?" },
      { role: "assistant", text: `PM2.5 is 40. ${ASK}` },
      { role: "user", text: "Here is a photo of my cooking shelter" },
    ];
    expect(previousReplyAsked(msgs, false)).toBe(true);
    expect(previousReplyAsked(msgs, true)).toBe(false);
    expect(previousReplyAsked(msgs.slice(0, 1), false)).toBe(false);
  });

  it("the agent loop stores and returns at most one ask per reply, and none on the next reply", async () => {
    const { runner } = setup({
      steps: [
        reply(`Let me check. ${ASK}`, [toolCall("getStatus", {})]),
        reply(`## Plan\nCook upwind.\n\n${ASK}`),
        reply(`Updated plan for the shelter.\n\n${ASK}`),
      ],
    });
    const s = await runner.createSession({});
    const first = await runner.sendMessage(s.id, "Air here?");
    expect(first.reply).toMatch(/asthma/);
    const second = await runner.sendMessage(s.id, "It's an open cooking shelter");
    expect(second.reply).toBe("Updated plan for the shelter.");
    const stored = (await runner.getSession(s.id)).messages.filter((m) => m.role === "assistant");
    const asks = stored.filter((m) => asksForProfile(typeof m.content === "string" ? m.content : ""));
    expect(asks).toHaveLength(1);
  });

  it("the system prompt limits the ask and says when not to ask again", () => {
    const sess = {
      id: "s",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: ASK },
        { role: "user", content: "photo" },
      ],
    } as unknown as Session;
    const p = buildDeveloperPrompt(sess, new Date(), "sandbox");
    expect(p).toMatch(/at most ONCE per reply/);
    expect(p).toMatch(/do NOT ask for it again/);
    expect(buildDeveloperPrompt({ id: "s", messages: [] } as unknown as Session, new Date(), "sandbox")).not.toMatch(/do NOT ask for it again/);
  });
});
