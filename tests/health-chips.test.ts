import { describe, expect, it } from "vitest";
import {
  HEALTH_CHIPS,
  STARTER_PROMPTS,
  activeChips,
  composerContext,
  isChipActive,
  profileFromChips,
  toggleChipText,
  toggleComposerChip,
} from "@/lib/healthChips";
import { assessHealth, mergeProfile } from "@/lib/agent/tools/getHealthContext";
import { HealthProfileSchema } from "@/lib/domain";

const chip = (id: string) => HEALTH_CHIPS.find((c) => c.id === id)!;

describe("health chips", () => {
  it("appends and removes clean comma-separated text without touching typed notes", () => {
    let t = toggleChipText("", chip("asthma"));
    expect(t).toBe("asthma");
    t = toggleChipText("Takes inhaler at night", chip("wheezing"));
    expect(t).toBe("Takes inhaler at night, wheezing");
    t = toggleChipText(t, chip("asthma"));
    expect(t).toBe("Takes inhaler at night, wheezing, asthma");
    t = toggleChipText(t, chip("wheezing"));
    expect(t).toBe("Takes inhaler at night, asthma");
    expect(isChipActive("ASTHMA.", chip("asthma"))).toBe(true);
    expect(isChipActive("severe asthma", chip("asthma"))).toBe(false);
  });

  it("builds a structured, schema-valid profile", () => {
    const p = profileFromChips(activeChips("asthma, child at home, older adult (65+), wheezing, run or exercise outdoors"))!;
    expect(p).toMatchObject({
      conditions: ["asthma"],
      symptoms: ["wheezing"],
      ageGroup: "older_adult",
      household: ["child"],
      activities: ["runs or exercises outdoors"],
    });
    expect(HealthProfileSchema.safeParse(p).success).toBe(true);
    expect(profileFromChips([])).toBeUndefined();
  });

  it("flags a sensitive household member and outdoor exposure without diagnosis wording", () => {
    const a = assessHealth(HealthProfileSchema.parse({ household: ["child"], activities: ["works outdoors"] }));
    expect(a.sensitiveGroup).toBe(true);
    expect(a.sensitivityReasons.join(" ")).toMatch(/household member: child/);
    expect(a.cautions.join(" ")).toMatch(/outdoor exposure/);
    const merged = mergeProfile(HealthProfileSchema.parse({ household: ["child"] }), HealthProfileSchema.parse({ household: ["older adult"] }), false);
    expect(merged.household).toEqual(["child", "older adult"]);
  });

  it("chip labels avoid diagnostic language", () => {
    for (const c of HEALTH_CHIPS) expect(c.label).not.toMatch(/diagnos|you have|suffer/i);
  });

  it("manages one context line in the composer message", () => {
    let m = toggleComposerChip("How is the air?", chip("coughing"));
    expect(m).toBe("How is the air?\nMy health context: coughing.");
    m = toggleComposerChip(m, chip("asthma"));
    expect(composerContext(m)).toBe("coughing, asthma");
    m = toggleComposerChip(toggleComposerChip(m, chip("coughing")), chip("asthma"));
    expect(m).toBe("How is the air?");
  });

  it("starter prompts never name a place", () => {
    for (const p of STARTER_PROMPTS) expect(`${p.label} ${p.message}`).not.toMatch(/\b(Lagos|London|Ilorin|Nairobi|Delhi|New York|Paris)\b/);
  });
});
