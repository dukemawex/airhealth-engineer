import type { AirQualitySnapshot } from "@/lib/domain";
import { pm25Category, pm25ToUsAqi } from "@/lib/services/aqi";
import { snapshotPm25 } from "@/lib/agent/sessionState";
import { formatPlace } from "@/lib/place";
import { POLLUTANT_LABEL, categoryTone, fmtNum, fmtTime, humanize } from "../format";
import { Sparkline } from "./Sparkline";
import { ShareCardButton } from "./ShareCardButton";

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
  const place = formatPlace(snapshot.location);
  const measured = snapshot.source === "openaq";
  const nearest = snapshot.readings
    .filter((r) => r.stationName)
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))[0];
  const gps = snapshot.location.source === "user_coordinates";
  return (
    <section className="card" aria-label={`Air quality${place ? ` for ${place}` : ""}`}>
      <div className="card-header">
        <div>
          <span className="kicker">
            Air now<span className="sep" aria-hidden="true" />
            {measured ? "Measured · OpenAQ" : "Modelled · CAMS"}
          </span>
          <h3 className="card-title">{place}</h3>
          <p className="place-meta">
            <span>{gps ? "Your shared location" : snapshot.location.query ? `From “${snapshot.location.query}”` : "Searched place"}</span>
            <span aria-hidden="true">·</span>
            <span>
              {snapshot.location.latitude.toFixed(3)}, {snapshot.location.longitude.toFixed(3)}
            </span>
            {gps && snapshot.location.accuracyMeters !== undefined && <span>±{Math.round(snapshot.location.accuracyMeters)} m</span>}
          </p>
        </div>
        {cat ? (
          <span className="badge" data-tone={categoryTone(cat)}>
            {humanize(cat)}
          </span>
        ) : (
          <span className="badge">No PM2.5 reading</span>
        )}
      </div>
      <div className="metric-row">
        <div className="aqi">
          <span className="aqi-value">{aqi ?? "—"}</span>
          <span className="aqi-label">US AQI (from PM2.5)</span>
        </div>
        <div className="aqi">
          <span className="aqi-value secondary">
            {fmtNum(pm25)}
          </span>
          <span className="aqi-label">PM2.5 µg/m³</span>
        </div>
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
        {nearest ? (
          <>
            Nearest station: <strong>{nearest.stationName}</strong>
            {nearest.distanceKm !== undefined ? ` · ${fmtNum(nearest.distanceKm)} km away` : ""}.{" "}
          </>
        ) : null}
        Updated {fmtTime(snapshot.fetchedAt, true)}. {snapshot.sourceNote}
      </p>
      {!compact && place && (
        <div className="card-actions">
          <ShareCardButton
            input={{ place, pm25: pm25 ?? null, aqi: aqi ?? null, category: cat ?? null, measured }}
          />
        </div>
      )}
    </section>
  );
}
