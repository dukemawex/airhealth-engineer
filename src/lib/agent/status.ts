import { shortPlace } from "../place";
import type { AirQualitySnapshot, Session } from "../domain";
import { CATEGORY_RANK, pm25Category, pm25ToUsAqi } from "../services/aqi";
import { snapshotPm25 } from "./sessionState";
import { assessHealth } from "./tools/getHealthContext";

export type CombinedLevel = "unknown" | "ok" | "watch" | "act" | "urgent";

export interface CombinedStatus {
  level: CombinedLevel;
  headline: string;
  reasons: string[];
  /** Journey steps derived from real state only. */
  steps: Array<{ key: "location" | "air" | "health" | "plan" | "approval" | "monitoring"; done: boolean; label: string; detail?: string }>;
}

/** Combine air quality, sensitivity profile and intervention state into one status. Pure function. */
export function combineStatus(input: {
  session: Session;
  aq?: AirQualitySnapshot;
  activeInterventions: number;
  proposedInterventions: number;
  pendingApprovals: number;
  executedActions: number;
}): CombinedStatus {
  const { session, aq } = input;
  const reasons: string[] = [];
  const assessment = session.profile ? assessHealth(session.profile) : undefined;
  const pm25 = aq ? snapshotPm25(aq) : undefined;
  const threshold = assessment?.actionThresholdPm25 ?? 35.4;
  let level: CombinedLevel = "unknown";
  if (pm25 !== undefined) {
    const cat = pm25Category(pm25);
    level = pm25 > threshold ? "act" : CATEGORY_RANK[cat] >= 1 ? "watch" : "ok";
    reasons.push(`Outdoor PM2.5 ${Math.round(pm25 * 10) / 10} µg/m³ (${cat.replaceAll("_", " ")})${assessment?.sensitiveGroup ? `; sensitive-group threshold ${threshold}` : ""}`);
    if (aq?.source !== "openaq") reasons.push("Air data is modelled, not measured by a nearby station");
  } else if (aq) {
    reasons.push("No PM2.5 reading available for this location");
    level = "watch";
  }
  if (assessment?.urgentCareAdvised) {
    level = "urgent";
    reasons.unshift(`Health red flags: ${assessment.redFlags.join(", ")}`);
  }
  if (input.activeInterventions > 0 && level === "act") reasons.push("Protective intervention active");
  if (input.pendingApprovals > 0) reasons.push(`${input.pendingApprovals} device action(s) awaiting your approval`);

  const headline =
    level === "urgent"
      ? "Seek medical care: health red flags reported"
      : level === "act"
        ? input.activeInterventions > 0
          ? "Air is above your threshold; protection active"
          : "Air is above your threshold; protection recommended"
        : level === "watch"
          ? "Keep an eye on air quality"
          : level === "ok"
            ? "Air is within your threshold"
            : "Share your location to start";

  const mon = session.monitoring;
  return {
    level,
    headline,
    reasons,
    steps: [
      { key: "location", done: Boolean(session.location), label: "Location", detail: session.location ? shortPlace(session.location) : undefined },
      { key: "air", done: Boolean(aq), label: "Air quality", detail: aq ? (aq.source === "openaq" ? "Measured (OpenAQ)" : "Modelled (CAMS)") : undefined },
      { key: "health", done: Boolean(session.profile), label: "Sensitivity profile", detail: session.profile ? (assessment?.sensitiveGroup ? "Sensitive group" : "Recorded") : undefined },
      { key: "plan", done: input.activeInterventions + input.proposedInterventions > 0, label: "Intervention plan", detail: input.activeInterventions > 0 ? "Active" : input.proposedInterventions > 0 ? "Proposed" : undefined },
      { key: "approval", done: input.executedActions > 0, label: "Approved actions", detail: input.pendingApprovals > 0 ? `${input.pendingApprovals} pending` : input.executedActions > 0 ? `${input.executedActions} executed` : undefined },
      { key: "monitoring", done: Boolean(mon?.lastCheckAt), label: "Monitoring", detail: mon?.lastCheckAt ? `Last check ${mon.lastCheckAt}` : session.location ? "Waiting for first re-check" : undefined },
    ],
  };
}
import type { DeviceAdapter } from "../devices";
import type { StateStore } from "../storage";

export async function buildStatusReport(
  session: Session,
  store: StateStore,
  deviceAdapter: DeviceAdapter | undefined,
  includeHistory = false,
) {
  const [interventions, approvals, deviceStates] = await Promise.all([
    store.listInterventions(session.id),
    store.listApprovals(session.id),
    deviceAdapter ? deviceAdapter.getStates(session.id) : store.getDeviceStates(session.id),
  ]);
  const aq = session.lastAirQuality;
  const ageMinutes = aq ? Math.round((Date.now() - Date.parse(aq.fetchedAt)) / 60000) : undefined;
  const sortDesc = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const combined = combineStatus({
    session,
    aq,
    activeInterventions: interventions.filter((i) => i.status === "active").length,
    proposedInterventions: interventions.filter((i) => i.status === "proposed").length,
    pendingApprovals: approvals.filter((a) => a.status === "pending").length,
    executedActions: approvals.filter((a) => a.status === "executed").length,
  });
  const pm25 = aq ? snapshotPm25(aq) : undefined;

  return {
    sessionId: session.id,
    combined,
    sessionStatus: session.status,
    location: session.location ?? null,
    airQuality: aq
      ? { ...aq, ageMinutes, refreshRecommended: (ageMinutes ?? 0) > 60, pm25, usAqi: pm25 !== undefined ? pm25ToUsAqi(pm25) : undefined }
      : null,
    airQualityHistory: session.airQualityHistory ?? [],
    healthAssessment: session.profile ? assessHealth(session.profile) : null,
    monitoring: session.monitoring ?? null,
    profileSummary: session.profile
      ? {
          ageGroup: session.profile.ageGroup,
          conditions: session.profile.conditions,
          symptoms: session.profile.symptoms,
          medications: session.profile.medications,
          activityPlans: session.profile.activityPlans,
          hasRecentData: Boolean(session.profile.recentData && Object.keys(session.profile.recentData).length),
        }
      : null,
    interventions: sortDesc(interventions)
      .filter((i) => includeHistory || i.status === "proposed" || i.status === "active")
      .map((i) => ({
        id: i.id,
        status: i.status,
        title: i.design.title,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        warnings: i.checks.warnings,
        objective: i.design.objective,
        filterClass: i.design.filtration.recommendedFilterClass,
        ventilationStrategy: i.design.ventilation.strategy,
        requiredCadrM3h: i.checks.requiredCadrM3h,
        recheckIntervalMinutes: i.design.monitoringPlan.recheckIntervalMinutes,
      })),
    pendingApprovals: approvals
      .filter((a) => a.status === "pending")
      .map((a) => ({ id: a.id, command: a.command, reason: a.reason, expiresAt: a.expiresAt })),
    recentDeviceActions: sortDesc(approvals)
      .filter((a) => (includeHistory ? a.status !== "pending" : a.status === "executed" || a.status === "failed"))
      .slice(0, includeHistory ? 50 : 10)
      .map((a) => ({
        approvalId: a.id,
        status: a.status,
        command: a.command,
        decidedAt: a.decidedAt,
        decidedBy: a.decidedBy,
        result: a.result ? { ok: a.result.ok, message: a.result.message, adapter: a.result.adapter } : undefined,
      })),
    deviceAdapter: deviceAdapter?.name ?? null,
    deviceStates,
  };
}

export type StatusReport = Awaited<ReturnType<typeof buildStatusReport>>;
