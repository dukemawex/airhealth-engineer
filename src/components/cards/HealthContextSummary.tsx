import type { HealthProfile } from "@/lib/domain";
import type { assessHealth } from "@/lib/agent/tools/getHealthContext";
import { humanize } from "../format";

type Assessment = ReturnType<typeof assessHealth>;

export function HealthContextSummary({
  profile,
  assessment,
  compact = false,
}: {
  profile?: Partial<HealthProfile> | null;
  assessment?: Assessment | null;
  compact?: boolean;
}) {
  const conditions = profile?.conditions ?? [];
  const symptoms = profile?.symptoms ?? [];
  return (
    <section className="card" data-tone={assessment?.urgentCareAdvised ? "danger" : undefined} aria-label="Health context">
      <div className="card-header">
        <div>
          <span className="kicker">Your health context</span>
          <h3 className="card-title">
            {assessment?.urgentCareAdvised ? "Red flags reported" : assessment?.sensitiveGroup ? "Extra protection advised" : "What you shared"}
          </h3>
        </div>
        {assessment && (
          <span className="badge" data-tone={assessment.urgentCareAdvised ? "danger" : assessment.sensitiveGroup ? "watch" : "ok"}>
            {assessment.urgentCareAdvised ? "Seek urgent care" : assessment.sensitiveGroup ? "Sensitive group" : "General population"}
          </span>
        )}
      </div>
      {assessment?.urgentCareAdvised && (
        <p role="alert" style={{ fontWeight: 600, color: "var(--color-danger)" }}>
          Red flags reported ({assessment.redFlags.join(", ")}). Contact emergency services or a clinician now.
        </p>
      )}
      <dl className="kv">
        {profile?.ageGroup && (
          <>
            <dt>Age group</dt>
            <dd>{humanize(profile.ageGroup)}</dd>
          </>
        )}
        <dt>Conditions</dt>
        <dd>{conditions.length ? conditions.join(", ") : "None shared"}</dd>
        <dt>Symptoms</dt>
        <dd>{symptoms.length ? symptoms.join(", ") : "None shared"}</dd>
        {!compact && profile?.medications?.length ? (
          <>
            <dt>Medications</dt>
            <dd>{profile.medications.join(", ")}</dd>
          </>
        ) : null}
        {!compact && profile?.activityPlans ? (
          <>
            <dt>Plans</dt>
            <dd>{profile.activityPlans}</dd>
          </>
        ) : null}
        {assessment && (
          <>
            <dt>Action threshold</dt>
            <dd>PM2.5 above {assessment.actionThresholdPm25} µg/m³</dd>
          </>
        )}
      </dl>
      {!compact && assessment?.cautions?.length ? (
        <ul className="list">
          {assessment.cautions.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      ) : null}
      <p className="card-sub">Decision support only, not a diagnosis.</p>
    </section>
  );
}
