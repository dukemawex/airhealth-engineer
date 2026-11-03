import type { AirQualitySnapshot, Session } from "../domain";

export const MAX_AQ_HISTORY = 96;

export function snapshotPm25(snapshot: AirQualitySnapshot): number | undefined {
  const r = snapshot.readings.find((x) => x.parameter === "pm25" && !x.stale) ?? snapshot.readings.find((x) => x.parameter === "pm25");
  return r?.value;
}

/** Store the latest real snapshot and append a trend point (never synthesised). */
export function recordAirQuality(session: Session, snapshot: AirQualitySnapshot) {
  session.location = snapshot.location;
  session.lastAirQuality = snapshot;
  const history = session.airQualityHistory ?? [];
  history.push({ at: snapshot.fetchedAt, pm25: snapshotPm25(snapshot), source: snapshot.source });
  session.airQualityHistory = history.slice(-MAX_AQ_HISTORY);
  session.monitoring = { ...(session.monitoring ?? { enabled: true }), enabled: session.monitoring?.enabled ?? true };
}
