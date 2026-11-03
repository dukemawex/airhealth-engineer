import { z } from "zod";
import type { AirQualitySnapshot, Intervention, MonitoringDecision, Session } from "../domain";
import type { ModelClient } from "../meta/types";
import { hashSafetyIdentifier } from "../meta/client";
import { snapshotPm25 } from "./sessionState";
import { assessHealth } from "./tools/getHealthContext";

const DecisionSchema = z.object({
  notify: z.boolean(),
  severity: z.enum(["info", "watch", "act"]).default("info"),
  message: z.string().max(1200).default(""),
});

export const MONITOR_PROMPT = `You are the monitoring component of AirHealth Engineer. You receive the previous and the newly fetched outdoor air-quality snapshot for one user, their health assessment and their active interventions.
Decide whether this change is worth interrupting the user for. Notify only for meaningful changes: crossing the user's PM2.5 action threshold in either direction, a jump of roughly 30% or more, a new pollutant concern (e.g. ozone), data that became unavailable, or a moment when it is now safe to ventilate. Do not notify for small fluctuations or if an equivalent message was sent recently.
Reply with ONLY a JSON object: {"notify": boolean, "severity": "info"|"watch"|"act", "message": string}. The message (max 3 sentences) must cite the actual numbers from the snapshots and suggest one concrete next step. Never claim any device was changed.`;

/** Extract the first JSON object from model text and validate it. */
export function parseDecision(text: string | null | undefined): Omit<MonitoringDecision, "at"> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = DecisionSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const brief = (s?: AirQualitySnapshot) =>
  s
    ? {
        fetchedAt: s.fetchedAt,
        source: s.source,
        pm25: snapshotPm25(s),
        category: s.pm25Category,
        readings: s.readings.map((r) => ({ p: r.parameter, v: r.value, u: r.units, stale: r.stale })),
      }
    : null;

/** Ask Muse Spark whether a monitoring change is worth telling the user about. */
export async function decideNotification(
  model: ModelClient,
  session: Session,
  previous: AirQualitySnapshot | undefined,
  current: AirQualitySnapshot,
  interventions: Intervention[],
): Promise<Omit<MonitoringDecision, "at">> {
  const res = await model.createChatCompletion({
    messages: [
      { role: "developer", content: MONITOR_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          location: session.location,
          previous: brief(previous),
          current: brief(current),
          health: session.profile ? assessHealth(session.profile) : null,
          activeInterventions: interventions
            .filter((i) => i.status === "active" || i.status === "proposed")
            .map((i) => ({ title: i.design.title, status: i.status, triggers: i.design.monitoringPlan.escalationTriggers })),
          lastNotification: session.monitoring?.lastDecision?.notify ? session.monitoring.lastDecision : null,
        }),
      },
    ],
    safety_identifier: hashSafetyIdentifier(session.userRef ?? session.id),
  });
  const decision = parseDecision(res.choices[0]?.message.content);
  // If the model reply can't be parsed we stay quiet rather than guessing.
  return decision ?? { notify: false, severity: "info", message: "" };
}
