import { z } from "zod";
import { HealthProfileSchema, type HealthProfile } from "../../domain";
import { defineTool } from "./types";

export const getHealthContextSchema = HealthProfileSchema.extend({
  replace: z
    .boolean()
    .default(false)
    .describe("true replaces the stored profile; false merges new conditions/symptoms/data into it"),
});

const RESPIRATORY = /(asthma|copd|bronch|emphysema|cystic fibrosis|lung|respirat|allerg|rhinitis|sinus)/i;
const CARDIO = /(heart|cardi|hypertens|blood pressure|stroke|arrhythm|angina|coronary)/i;
const OTHER_SENSITIVE = /(pregnan|diabet|immun|cancer|chemo|kidney|sickle)/i;
/** Respiratory symptoms that put someone in the sensitive (respiratory) group for air targets. */
export const RESPIRATORY_SYMPTOMS =
  /(wheez|cough|short(ness)? of breath|breathless|out of breath|chest tight|tight(ness in the)? chest|difficulty breathing|trouble breathing|hard to breathe|asthma (attack|flare))/i;
const RED_FLAG_SYMPTOMS =
  /(chest pain|crushing|severe (shortness of breath|breathless)|can'?t (breathe|speak)|unable to (breathe|speak)|blue lips|cyanosis|confus|faint|unconscious|collapse|seizure)/i;

export function mergeProfile(current: HealthProfile | undefined, update: HealthProfile, replace: boolean): HealthProfile {
  if (replace || !current) return update;
  const uniq = (xs: string[]) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()];
  return {
    ...current,
    ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)),
    conditions: uniq([...(current.conditions ?? []), ...(update.conditions ?? [])]),
    symptoms: uniq([...(current.symptoms ?? []), ...(update.symptoms ?? [])]),
    medications: uniq([...(current.medications ?? []), ...(update.medications ?? [])]),
    household: uniq([...(current.household ?? []), ...(update.household ?? [])]),
    activities: uniq([...(current.activities ?? []), ...(update.activities ?? [])]),
    recentData: { ...(current.recentData ?? {}), ...(update.recentData ?? {}) },
  };
}

export function assessHealth(profile: HealthProfile) {
  const conditions = profile.conditions ?? [];
  const symptoms = profile.symptoms ?? [];
  const d = profile.recentData ?? {};
  const sensitivityReasons: string[] = [];
  if (conditions.some((c) => RESPIRATORY.test(c))) sensitivityReasons.push("respiratory condition");
  if (conditions.some((c) => CARDIO.test(c))) sensitivityReasons.push("cardiovascular condition");
  if (conditions.some((c) => OTHER_SENSITIVE.test(c))) sensitivityReasons.push("other at-risk condition");
  const respSymptoms = symptoms.filter((s) => RESPIRATORY_SYMPTOMS.test(s) && !RED_FLAG_SYMPTOMS.test(s));
  if (respSymptoms.length) sensitivityReasons.push(`respiratory symptoms: ${respSymptoms.join(", ")}`);
  if (profile.ageGroup && ["infant", "child", "older_adult"].includes(profile.ageGroup)) {
    sensitivityReasons.push(`age group: ${profile.ageGroup}`);
  }
  const household = (profile.household ?? []).filter((h) => /(child|kid|infant|baby|older|elder|65|pregnan)/i.test(h));
  if (household.length) sensitivityReasons.push(`sensitive household member: ${household.join(", ")}`);

  const redFlags: string[] = symptoms.filter((s) => RED_FLAG_SYMPTOMS.test(s));
  if (d.spo2Percent !== undefined && d.spo2Percent < 92) redFlags.push(`SpO2 ${d.spo2Percent}% (< 92%)`);
  if (d.respiratoryRatePerMin !== undefined && d.respiratoryRatePerMin > 30) {
    redFlags.push(`respiratory rate ${d.respiratoryRatePerMin}/min (> 30)`);
  }
  const cautions: string[] = [];
  if (d.peakFlowLpm !== undefined && d.personalBestPeakFlowLpm) {
    const pct = Math.round((d.peakFlowLpm / d.personalBestPeakFlowLpm) * 100);
    if (pct < 50) redFlags.push(`peak flow ${pct}% of personal best (< 50%)`);
    else if (pct < 80) cautions.push(`peak flow ${pct}% of personal best (below 80%): use tighter air targets`);
  }
  if (d.indoorCo2Ppm !== undefined && d.indoorCo2Ppm > 1000) {
    cautions.push(`indoor CO2 ${d.indoorCo2Ppm} ppm (> 1000): needs fresh air, ideally filtered`);
  }
  if (d.indoorHumidityPercent !== undefined && (d.indoorHumidityPercent < 30 || d.indoorHumidityPercent > 60)) {
    cautions.push(`indoor humidity ${d.indoorHumidityPercent}% outside 30-60%`);
  }
  for (const a of profile.activities ?? []) {
    cautions.push(`regular outdoor exposure (${a}): schedule outdoor tasks in the cleanest hours`);
  }
  if (d.indoorPm25 !== undefined && d.indoorPm25 > 9) cautions.push(`indoor PM2.5 ${d.indoorPm25} µg/m³ (> 9)`);

  const sensitive = sensitivityReasons.length > 0;
  const respiratory =
    conditions.some((c) => RESPIRATORY.test(c)) || symptoms.some((s) => RESPIRATORY_SYMPTOMS.test(s));
  return {
    sensitiveGroup: sensitive,
    /** Which sensitive group drives the tighter targets (respiratory first: it matters most for PM2.5). */
    group: (sensitive ? (respiratory ? "respiratory" : "sensitive") : "general") as "respiratory" | "sensitive" | "general",
    sensitivityReasons,
    redFlags,
    urgentCareAdvised: redFlags.length > 0,
    cautions,
    // Action threshold for outdoor PM2.5 (µg/m³) above which protective engineering measures are recommended.
    actionThresholdPm25: sensitive ? 9.0 : 35.4,
    recommendedTargetAirChangesPerHour: sensitive ? 5 : 4,
  };
}

export const getHealthContextTool = defineTool({
  name: "getHealthContext",
  description:
    "Record and assess the user's sensitivity profile (conditions, symptoms, age group, sensitive household members, outdoor activities, medications, recent vitals/indoor sensor data). Returns how strict the air targets should be, any red flags that mean the user should contact a clinician first, and engineering thresholds. Call when the user shares health information or before designing an intervention.",
  schema: getHealthContextSchema,
  requiresApproval: false,
  async execute(args, ctx) {
    const { replace, ...update } = args;
    const profile = mergeProfile(ctx.session.profile, update, replace);
    ctx.session.profile = profile;
    return {
      profile,
      assessment: assessHealth(profile),
      disclaimer:
        "Sets air-engineering targets only, not medical advice. If red flags are present, tell the user to contact emergency services or a clinician first, then continue with air engineering only.",
    };
  },
});
