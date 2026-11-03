import { describe, expect, it } from "vitest";
import { fmtClock, simulateAirTwin, twinTarget } from "@/lib/airTwin";
import { computeChecks } from "@/lib/agent/tools/designIntervention";
import { planView } from "@/components/cards/InterventionPlanCard";
import { twinHeadline } from "@/components/cards/AirTwinChart";
import { InterventionDesignSchema, type Session } from "@/lib/domain";
import { minimalDesign } from "./helpers";

const base = { outdoorPm25: 40, roomVolumeM3: 30, cadrM3h: 150, targetPm25: 9, startIso: "2026-11-03T18:00:00.000Z", timezone: "Africa/Lagos" };

describe("air twin model", () => {
  it("as-is levels off near the outdoor-driven steady state; the plan falls below target", () => {
    const t = simulateAirTwin(base)!;
    expect(t.kind).toBe("model");
    // as-is steady = 1.5*0.8*40/(1.5+0.2) ≈ 28.2, and the start uses it when no indoor reading exists
    expect(t.asIsSteadyPm25).toBeCloseTo(28.2, 1);
    expect(t.startPm25).toBeCloseTo(28.2, 1);
    expect(t.startSource).toBe("modelled_as_is");
    // plan: L = 0.5+0.2+5 = 5.7/h, css = 0.5*0.8*40/5.7 ≈ 2.8
    expect(t.planSteadyPm25).toBeCloseTo(2.8, 1);
    const expected = Math.ceil((-Math.log((9 - 160 / 57) / (480 / 17 - 160 / 57)) / 5.7) * 60);
    expect(t.minutesToTarget).toBe(expected);
    expect(t.minutesToTarget).toBeGreaterThan(5);
    expect(t.minutesToTarget).toBeLessThan(30);
    expect(t.withPlan).toHaveLength(37);
    expect(t.withPlan.at(-1)!).toBeLessThan(t.asIs.at(-1)!);
    expect(t.withPlan.every((v, i) => i === 0 || v <= t.withPlan[i - 1]!)).toBe(true);
    expect(fmtClock(t.belowTargetAtIso!, "Africa/Lagos")).toBe(fmtClock(new Date(Date.parse(base.startIso) + expected * 60_000).toISOString(), "Africa/Lagos"));
    expect(fmtClock(base.startIso, "Africa/Lagos")).toBe("19:00");
    expect(twinHeadline(t)).toMatch(/^Below 9 µg\/m³ by 19:\d\d/);
  });

  it("uses a measured indoor reading and handles already-below and never-reaches", () => {
    expect(simulateAirTwin({ ...base, indoorPm25: 60 })!.startSource).toBe("measured_indoor");
    const below = simulateAirTwin({ ...base, indoorPm25: 5 })!;
    expect(below.minutesToTarget).toBe(0);
    expect(twinHeadline(below)).toMatch(/Already below/);
    const weak = simulateAirTwin({ ...base, outdoorPm25: 300, cadrM3h: 20 })!;
    expect(weak.minutesToTarget).toBeNull();
    expect(weak.belowTargetAtIso).toBeNull();
    expect(twinHeadline(weak)).toMatch(/needs more CADR/);
    expect(simulateAirTwin({ ...base, roomVolumeM3: 0 })).toBeNull();
  });

  it("targets 9 for sensitive groups, 15 otherwise", () => {
    expect(twinTarget(true)).toBe(9);
    expect(twinTarget(false)).toBe(15);
  });

  it("is computed for indoor plans and hidden for open spaces", () => {
    const session = {
      id: "s",
      messages: [],
      location: { latitude: 8.3, longitude: 4.5, timezone: "Africa/Lagos", source: "user_coordinates" },
      profile: { conditions: ["asthma"] },
      lastAirQuality: { location: { latitude: 8.3, longitude: 4.5, source: "user_coordinates" }, source: "openaq", sourceNote: "", fetchedAt: "", readings: [{ parameter: "pm25", value: 40, units: "µg/m³" }] },
    } as unknown as Session;
    const design = InterventionDesignSchema.parse(minimalDesign);
    const checks = computeChecks(design, session, "indoor");
    expect(checks.airTwin?.cadrM3h).toBe(150);
    expect(checks.airTwin?.targetPm25).toBe(9);
    expect(checks.airTwin?.timezone).toBe("Africa/Lagos");
    expect(planView(design, checks).airTwin).toBeDefined();
    expect(computeChecks(design, session, "semi_open").airTwin).toBeUndefined();
    expect(planView(design, { ...checks, space: "outdoor" }).airTwin).toBeUndefined();
  });
});
