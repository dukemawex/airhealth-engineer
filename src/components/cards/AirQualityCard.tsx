import type { AirQualitySnapshot } from "@/lib/domain";
import { pm25Category, pm25ToUsAqi } from "@/lib/services/aqi";
import { snapshotPm25 } from "@/lib/agent/sessionState";
import { POLLUTANT_LABEL, categoryTone, fmtNum, fmtTime, humanize } from "../format";
import { Sparkline } from "./Sparkline";

export function AirQualityCard({
  snapshot,
  history = [],
  compact = false,
}: {
  snapshot: AirQualitySnapshot;
  history?: Array<{ at: string; pm25?: number }>;
  compact?: boolean;
}) {
  const pm25 = snapshotPm25(snapshot);
  const cat = pm25 !== undefined ? pm25Category(pm25) : undefined;
  const aqi = pm25 !== undefined ? pm25ToUsAqi(pm25) : undefined;
  const place = [snapshot.location.name, snapshot.location.admin1, snapshot.location.country].filter(Boolean).join(", ");
  const measured = snapshot.source === "openaq";
  const station = snapshot.readings.find((r) => r.stationName)?.stationName;
  return (
    <section className="card" aria-label={`Air quality${place ? ` for ${place}` : ""}`}>
      <div className="card-header">
        <div>
          <div className="card-title">Air quality</div>
          <div className="card-sub">{place || `${snapshot.location.latitude.toFixed(3)}, ${snapshot.location.longitude.toFixed(3)}`}</div>
        </div>
        <span className="badge" data-tone={measured ? "info" : "watch"}>
          {measured ? "Measured · OpenAQ" : "Modelled · CAMS"}
        </span>
      </div>
      <div className="metric-row">
        <div className="aqi">
          <span className="aqi-value">{aqi ?? "—"}</span>
          <span className="aqi-label">US AQI (from PM2.5)</span>
        </div>
        <div className="aqi">
          <span className="aqi-value" style={{ fontSize: "var(--text-xl)" }}>
            {fmtNum(pm25)}
          </span>
          <span className="aqi-label">PM2.5 µg/m³</span>
        </div>
        {cat ? (
          <span className="badge" data-tone={categoryTone(cat)}>
            {humanize(cat)}
          </span>
        ) : (
          <span className="badge">No PM2.5 reading</span>
        )}
        {!compact && <Sparkline points={history} label={`PM2.5 trend from ${history.length} readings`} />}
      </div>
      {!compact && snapshot.readings.length > 0 && (
        <ul className="pollutants" aria-label="Pollutant readings">
          {snapshot.readings.map((r) => (
            <li className="pollutant" key={`${r.parameter}-${r.stationName ?? ""}`}>
              <div className="name">{POLLUTANT_LABEL[r.parameter] ?? r.parameter}</div>
              <div className="value">
                {fmtNum(r.value)} <span className="card-sub">{r.units}</span>
              </div>
              {r.stale && <div className="card-sub">stale</div>}
            </li>
          ))}
        </ul>
      )}
      <p className="card-sub">
        {station ? `Nearest station: ${station}. ` : ""}
        Updated {fmtTime(snapshot.fetchedAt, true)}. {snapshot.sourceNote}
      </p>
    </section>
  );
}
