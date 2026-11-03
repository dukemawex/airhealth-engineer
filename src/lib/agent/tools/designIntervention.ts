import { simulateAirTwin, twinTarget } from "../../airTwin";
import {
  INDOOR_VENT_MODES,
  InterventionDesignSchema,
  type EngineeringChecks,
  type Intervention,
  type InterventionDesign,
  type Session,
} from "../../domain";
import { INDOOR_ONLY_DEVICES, isOpenSpace, notApplicableNote, SPACE_LABEL, spaceFromSetting, type SpaceType } from "../../space";
import { newId, nowIso } from "../../ids";
import { CATEGORY_RANK, pm25Category } from "../../services/aqi";
import { assessHealth } from "./getHealthContext";
import { defineTool } from "./types";

const M3H_TO_CFM = 0.588578;

/** The design's declared space, else the latest photo's setting, else indoor. */
export function resolveSpace(design: Pick<InterventionDesign, "space">, session: Pick<Session, "scene">): SpaceType {
  return design.space ?? spaceFromSetting(session.scene?.analysis.setting) ?? "indoor";
}

/**
 * Enforce the space on a design, whatever the model wrote: an open-sided or
 * outdoor plan never carries purifier sizing, window/HVAC schedules or indoor
 * device commands. Returns the adapted design and what was removed.
 */
export function adaptDesignForSpace(design: InterventionDesign, space: SpaceType): { design: InterventionDesign; removed: string[] } {
  if (!isOpenSpace(space)) return { design: { ...design, space }, removed: [] };
  const removed: string[] = [];
  const indoorModes = new Set<string>(INDOOR_VENT_MODES);
  const schedule = design.ventilation.schedule.flatMap((s) => {
    if (!indoorModes.has(s.mode)) return [s];
    // Opening up / purging becomes "let it disperse"; sealed or ducted modes have no meaning in open air.
    if (s.mode === "windows_open" || s.mode === "purge") {
      removed.push(`${s.start}–${s.end} ${s.mode.replace("_", " ")} → open dispersion`);
      return [{ start: s.start, end: s.end, mode: "open_dispersion" as const, rationale: s.rationale }];
    }
    removed.push(`${s.start}–${s.end} ${s.mode.replace("_", " ")} (needs an enclosed room)`);
    return [];
  });
  const indoorDevices = new Set<string>(INDOOR_ONLY_DEVICES);
  const deviceCommands = design.deviceCommands.filter((c) => {
    if (!indoorDevices.has(c.deviceType)) return true;
    removed.push(`${c.deviceType.replace("_", " ")} ${c.deviceId}: ${c.action.replace("_", " ")} (indoor device)`);
    return false;
  });
  const { targetAirChangesPerHour: _ach, purifierFanSetting: _fan, ...filtration } = design.filtration;
  if (_ach !== undefined || _fan !== undefined) removed.push("purifier air-change target");
  return {
    design: {
      ...design,
      space,
      room: undefined,
      filtration: { ...filtration, recommendedFilterClass: "NONE" },
      ventilation: { ...design.ventilation, strategy: "open_air_dispersion", schedule },
      deviceCommands,
    },
    removed,
  };
}

export function computeChecks(design: InterventionDesign, session: Session, space: SpaceType = resolveSpace(design, session)): EngineeringChecks {
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
    warnings.push("Red-flag symptoms were shared: point the user to emergency services or a clinician first, then continue with air engineering only.");
  }

  if (isOpenSpace(space)) {
    // No purifier sizing or window logic in open air: report that plainly instead of a meaningless number.
    return {
      outdoorPm25: pm25,
      outdoorPm25Category: category,
      space,
      notApplicable: [notApplicableNote(space)],
      warnings,
    };
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

  const airTwin =
    pm25 !== undefined && roomVolumeM3 !== undefined && requiredCadrM3h !== undefined
      ? (simulateAirTwin({
          outdoorPm25: pm25,
          roomVolumeM3,
          cadrM3h: requiredCadrM3h,
          targetPm25: twinTarget(Boolean(assessment?.sensitiveGroup)),
          indoorPm25: session.profile?.recentData?.indoorPm25,
          startIso: nowIso(),
          timezone: session.location?.timezone ?? aq?.location.timezone,
        }) ?? undefined)
      : undefined;

  return {
    roomVolumeM3,
    targetAirChangesPerHour: targetAch,
    airTwin,
    requiredCadrM3h,
    requiredCadrCfm: requiredCadrM3h !== undefined ? Math.round(requiredCadrM3h * M3H_TO_CFM) : undefined,
    outdoorPm25: pm25,
    outdoorPm25Category: category,
    space,
    warnings,
  };
}

export const designInterventionTool = defineTool({
  name: "designIntervention",
  description:
    "Record a structured engineering intervention you designed: filtration (filter class, target ACH), ventilation schedule (local HH:MM), route alternatives, exposure steps, monitoring plan and proposed device commands. The tool validates it, computes engineering checks (room volume, required purifier CADR, conflicts with current air quality) and stores it as 'proposed'. Set space to semi_open or outdoor for open-sided shelters and open air: those plans get no purifier CADR/ACH, no window/HVAC schedule and no indoor device commands (use open_dispersion, stay_upwind or reduce_source). It does NOT execute any device command. Revise the design if checks return warnings.",
  schema: InterventionDesignSchema,
  requiresApproval: false,
  async execute(input, ctx) {
    const space = resolveSpace(input, ctx.session);
    const { design, removed } = adaptDesignForSpace(input, space);
    const checks = computeChecks(design, ctx.session, space);
    if (removed.length) checks.warnings.push(`${SPACE_LABEL[space]}: removed indoor-only items: ${removed.join("; ")}.`);
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
      space,
      // The stored design after space rules were applied; the plan card renders this.
      design,
      checks,
      next:
        design.deviceCommands.length > 0
          ? "To actuate devices, call executeDeviceAction once per command with this interventionId. Each call requires explicit human approval."
          : "No device commands proposed.",
    };
  },
});
