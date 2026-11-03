import type { HealthProfile } from "./domain";

/**
 * Tap-to-toggle health-context suggestions. Each chip owns one short phrase in the
 * free-text field and maps to structured fields for getHealthContext. Labels describe
 * the user's situation; they are not diagnoses.
 */
export type HealthChipKind = "about" | "symptom";
export type HealthChip = {
  id: string;
  label: string;
  /** The exact phrase written into / removed from the text field. */
  phrase: string;
  kind: HealthChipKind;
  profile: Partial<Pick<HealthProfile, "ageGroup" | "conditions" | "symptoms" | "household" | "activities">>;
};

export const HEALTH_CHIPS: HealthChip[] = [
  { id: "asthma", label: "Asthma", phrase: "asthma", kind: "about", profile: { conditions: ["asthma"] } },
  { id: "allergies", label: "Allergies / hay fever", phrase: "allergies / hay fever", kind: "about", profile: { conditions: ["allergies / hay fever"] } },
  { id: "copd", label: "COPD", phrase: "COPD", kind: "about", profile: { conditions: ["COPD"] } },
  { id: "heart", label: "Heart condition", phrase: "heart condition", kind: "about", profile: { conditions: ["heart condition"] } },
  { id: "pregnant", label: "Pregnant", phrase: "pregnant", kind: "about", profile: { conditions: ["pregnancy"] } },
  { id: "child", label: "Child at home", phrase: "child at home", kind: "about", profile: { household: ["child"] } },
  { id: "older", label: "Older adult (65+)", phrase: "older adult (65+)", kind: "about", profile: { ageGroup: "older_adult" } },
  { id: "diabetes", label: "Diabetes", phrase: "diabetes", kind: "about", profile: { conditions: ["diabetes"] } },
  { id: "outdoor-work", label: "Outdoor worker", phrase: "work outdoors", kind: "about", profile: { activities: ["works outdoors"] } },
  { id: "runner", label: "Runner / exercising outdoors", phrase: "run or exercise outdoors", kind: "about", profile: { activities: ["runs or exercises outdoors"] } },
  { id: "coughing", label: "Coughing", phrase: "coughing", kind: "symptom", profile: { symptoms: ["coughing"] } },
  { id: "wheezing", label: "Wheezing", phrase: "wheezing", kind: "symptom", profile: { symptoms: ["wheezing"] } },
  { id: "breath", label: "Shortness of breath", phrase: "shortness of breath", kind: "symptom", profile: { symptoms: ["shortness of breath"] } },
  { id: "headache", label: "Headache", phrase: "headache", kind: "symptom", profile: { symptoms: ["headache"] } },
  { id: "eyes", label: "Itchy eyes", phrase: "itchy eyes", kind: "symptom", profile: { symptoms: ["itchy eyes"] } },
];

/** Neutral starter prompts; none names a city. `useLocation` asks the device for a position first. */
export const STARTER_PROMPTS: Array<{ id: string; label: string; message: string; useLocation?: boolean }> = [
  { id: "check-now", label: "Use my location and check the air now", message: "Check the air quality where I am right now and tell me what it means for me today.", useLocation: true },
  { id: "commute", label: "Plan a safer route for my commute", message: "Plan a safer time and route for my commute today based on the air where I am." },
  { id: "purifier", label: "Set up my purifier for tonight", message: "Set up my air purifier and ventilation for tonight so I sleep in clean air." },
  { id: "outdoors", label: "Is it OK to exercise outside today?", message: "Is it a good idea to exercise outdoors today where I am? Suggest the best time window." },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Split free text into comma/semicolon/newline-separated segments. */
function segments(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim().replace(/\.$/, "").trim())
    .filter(Boolean);
}

export function isChipActive(text: string, chip: HealthChip): boolean {
  const p = norm(chip.phrase);
  return segments(text).some((s) => norm(s) === p);
}

/** Append the chip's phrase, or remove it (and the separator) if it is already there. */
export function toggleChipText(text: string, chip: HealthChip): string {
  const segs = segments(text);
  const p = norm(chip.phrase);
  const next = segs.some((s) => norm(s) === p) ? segs.filter((s) => norm(s) !== p) : [...segs, chip.phrase];
  return next.join(", ");
}

export function activeChips(text: string): HealthChip[] {
  return HEALTH_CHIPS.filter((c) => isChipActive(text, c));
}

/** Structured profile for the chips present in the text; undefined when none are. */
export function profileFromChips(chips: HealthChip[]): HealthProfile | undefined {
  if (chips.length === 0) return undefined;
  const out: HealthProfile = { conditions: [], symptoms: [] };
  for (const c of chips) {
    if (c.profile.ageGroup) out.ageGroup = c.profile.ageGroup;
    out.conditions.push(...(c.profile.conditions ?? []));
    out.symptoms.push(...(c.profile.symptoms ?? []));
    if (c.profile.household) out.household = [...(out.household ?? []), ...c.profile.household];
    if (c.profile.activities) out.activities = [...(out.activities ?? []), ...c.profile.activities];
  }
  return out;
}

/* ---- Composer: chips manage one "My sensitivity profile: …" line inside the message ---- */

const CONTEXT_LINE = /^my (?:sensitivity profile|health context):\s*(.*?)\.?\s*$/im;

export function composerContext(message: string): string {
  return CONTEXT_LINE.exec(message)?.[1] ?? "";
}

export function toggleComposerChip(message: string, chip: HealthChip): string {
  const ctx = toggleChipText(composerContext(message), chip);
  const without = message.replace(CONTEXT_LINE, "").replace(/\n{2,}/g, "\n").trim();
  if (!ctx) return without;
  return `${without ? `${without}\n` : ""}My sensitivity profile: ${ctx}.`;
}
