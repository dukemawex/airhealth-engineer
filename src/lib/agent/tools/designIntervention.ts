import { InterventionDesignSchema, type EngineeringChecks, type Intervention, type InterventionDesign, type Session } from "../../domain";
import { newId, nowIso } from "../../ids";
import { CATEGORY_RANK, pm25Category } from "../../services/aqi";
import { assessHealth } from "./getHealthContext";
import { defineTool } from "./types";

const M3H_TO_CFM = 0.588578;

export function computeChecks(design: InterventionDesign, session: Session): EngineeringChecks {
  const warnings: string[] = [];
  const assessment = session.profile ? assessHealth(session.profile) : undefined;
  const aq = session.lastAirQuality;
  const pm25 = aq?.readings.find((r) => r.parameter === "pm25" && !r.stale)?.value;
  const category = pm25 !== undefined ? pm25Category(pm25) : undefined;
  const bad = category !== undefined && CATEGORY_RANK[category] >= CATEGORY_RANK.unhealthy_for_sensitive_groups;
  const aboveAction = pm25 !== undefined && assessment !== undefined && pm25 > assessment.actionThresholdPm25;

  if (!aq) warnings.push("No air-quality data in this session yet; call getAirQuality and re-check this design.");
  if (aq?.source === "open-meteo-cams-model") warnings.push("Outdoor data is modelled, not measured.");
  if (assessment?.urgentCareAdvised) {
    warnings.push("Health red flags present: urgent medical care must be advised before engineering measures.");
  }

  const targetAch =
    design.filtration.targetAirChangesPerHour ?? assessment?.recommendedTargetAirChangesPerHour ?? 4;
  let roomVolumeM3: number | undefined;
  let requiredCadrM3h: number | undefined;
  if (design.room) {
    roomVolumeM3 = Math.round(design.room.floorAreaM2 * design.room.ceilingHeightM * 10) / 10;
    requiredCadrM3h = Math.round(roomVolumeM3 * targetAch);
  } else {
    warnings.push("No room dimensions given; purifier CADR cannot be sized. Ask for floor area and ceiling height.");
  }

  if (bad || aboveAction) {
    if (design.ventilation.schedule.some((s) => s.mode === "windows_open")) {
      warnings.push(`Schedule opens windows while outdoor PM2.5 is ${pm25} µg/m³ (${category}).`);
    }
    if (design.deviceCommands.some((c) => c.deviceType === "window" && c.action !== "close" && (c.positionPercent ?? 100) > 0)) {
      warnings.push("A device command opens a window during poor outdoor air quality.");
    }
    if (design.filtration.recommendedFilterClass === "NONE") {
      warnings.push("No filtration recommended despite elevated PM2.5.");
    }
    if (design.ventilation.strategy === "natural_when_clean") {
      warnings.push("Natural ventilation strategy chosen while outdoor air is not clean.");
    }
  }
  const o3 = aq?.readings.find((r) => r.parameter === "o3" && !r.stale);
  // 8-h O3 ~0.070 ppm ≈ 140 µg/m³ (approximate screening threshold).
  const o3High = o3 !== undefined && (o3.units.toLowerCase() === "ppm" ? o3.value > 0.07 : o3.value > 140);
  if (o3High) {
    if (!["ACTIVATED_CARBON", "HEPA_PLUS_CARBON"].includes(design.filtration.recommendedFilterClass)) {
      warnings.push("Elevated ozone: particle filters do not remove gases; consider activated carbon.");
    }
  }

  return {
    roomVolumeM3,
    targetAirChangesPerHour: targetAch,
    requiredCadrM3h,
    requiredCadrCfm: requiredCadrM3h !== undefined ? Math.round(requiredCadrM3h * M3H_TO_CFM) : undefined,
    outdoorPm25: pm25,
    outdoorPm25Category: category,
    warnings,
  };
}

export const designInterventionTool = defineTool({
  name: "designIntervention",
  description:
    "Record a structured engineering intervention you designed: filtration (filter class, target ACH), ventilation schedule (local HH:MM), route alternatives, health precautions, monitoring plan and proposed device commands. The tool validates it, computes engineering checks (room volume, required purifier CADR, conflicts with current air quality) and stores it as 'proposed'. It does NOT execute any device command. Revise the design if checks return warnings.",
  schema: InterventionDesignSchema,
  requiresApproval: false,
  async execute(design, ctx) {
    const checks = computeChecks(design, ctx.session);
    const now = nowIso();
    const intervention: Intervention = {
      id: newId("int"),
      sessionId: ctx.session.id,
      status: "proposed",
      createdAt: now,
      updatedAt: now,
      design,
      checks,
      location: ctx.session.location,
    };
    await ctx.store.putIntervention(intervention);
    return {
      interventionId: intervention.id,
      status: intervention.status,
      checks,
      next:
        design.deviceCommands.length > 0
          ? "To actuate devices, call executeDeviceAction once per command with this interventionId. Each call requires explicit human approval."
          : "No device commands proposed.",
    };
  },
});
