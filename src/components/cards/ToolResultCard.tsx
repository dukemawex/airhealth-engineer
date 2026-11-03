"use client";

import type { AirQualitySnapshot, DeviceCommand, EngineeringChecks, HealthProfile, InterventionDesign } from "@/lib/domain";
import type { assessHealth } from "@/lib/agent/tools/getHealthContext";
import { AirQualityCard } from "./AirQualityCard";
import { HealthContextSummary } from "./HealthContextSummary";
import { InterventionPlanCard, describeCommand } from "./InterventionPlanCard";
import { humanize } from "../format";
import { ForecastPlanCard, type ForecastPlanOutput } from "./ForecastPlanCard";
import { LocationRequestCard } from "../location/LocationRequestCard";

export interface ToolPartView {
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  /** Latest streamed progress line while the tool runs. */
  progress?: string;
}

const TOOL_LABEL: Record<string, string> = {
  getAirQuality: "Checking air quality",
  getHealthContext: "Reading sensitivity profile",
  designIntervention: "Designing intervention",
  executeDeviceAction: "Preparing device action",
  getStatus: "Reviewing status",
  planForecast: "Planning the next 72 hours",
  requestLocation: "Asking for your location",
};

/** True when this tool part is (or will render as) the Share-my-location card. */
export function isLocationRequestPart(part: Pick<ToolPartView, "toolName" | "state" | "output">): boolean {
  if (part.toolName === "requestLocation") return true;
  const o = part.output as Record<string, unknown> | undefined;
  return part.state === "output-available" && Boolean(o && o.needsLocation === true);
}

function Pending({ name, progress }: { name: string; progress?: string }) {
  return (
    <div className="card" aria-busy="true" aria-live="polite">
      <div className="loading">
        <span className="typing" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {progress ?? `${TOOL_LABEL[name] ?? `Running ${name}`}…`}
      </div>
      <div className="skeleton" style={{ width: "70%" }} />
    </div>
  );
}

function ErrorCard({ name, message }: { name: string; message: string }) {
  return (
    <section className="card" data-tone="error" aria-label={`${name} failed`}>
      <span className="kicker">Not available</span>
      <h3 className="card-title">{humanize(TOOL_LABEL[name] ?? name)}</h3>
      <p style={{ fontSize: "var(--text-sm)" }}>{message}</p>
    </section>
  );
}

export function ToolResultCard({
  part,
  history,
  onApplyStep,
  busy,
}: {
  part: ToolPartView;
  history?: Array<{ at: string; pm25?: number }>;
  onApplyStep?: (text: string) => void;
  busy?: boolean;
}) {
  const { toolName, state } = part;
  const output = part.output as Record<string, unknown> | undefined;

  if (state === "output-error") return <ErrorCard name={toolName} message={part.errorText ?? "The tool failed."} />;

  // executeDeviceAction waits for approval: the approval card renders it.
  if (toolName === "executeDeviceAction" && state !== "output-available") return null;
  if (toolName === "requestLocation") {
    if (state !== "output-available") return <LocationRequestCard />;
    if (output?.alreadyKnown) return null;
    return <LocationRequestCard reason={typeof output?.reason === "string" ? output.reason : undefined} />;
  }
  if (state !== "output-available") return <Pending name={toolName} progress={part.progress} />;
  // "No location yet" is not a failure: show the friendly location card instead of "Not available".
  if (output?.needsLocation === true) return <LocationRequestCard />;
  if (output && typeof output.error === "string") return <ErrorCard name={toolName} message={output.error} />;

  switch (toolName) {
    case "getAirQuality":
      return <AirQualityCard snapshot={output as unknown as AirQualitySnapshot} history={history} />;
    case "getHealthContext":
      return (
        <HealthContextSummary
          profile={output?.profile as HealthProfile}
          assessment={output?.assessment as ReturnType<typeof assessHealth>}
        />
      );
    case "planForecast":
      return <ForecastPlanCard output={output as unknown as ForecastPlanOutput} onApplyStep={onApplyStep} busy={busy} />;
    case "designIntervention":
      return (
        <InterventionPlanCard
          design={(output?.design ?? part.input ?? {}) as Partial<InterventionDesign>}
          checks={output?.checks as EngineeringChecks}
          status={output?.status as string}
        />
      );
    case "executeDeviceAction": {
      const status = String(output?.status ?? "");
      const command = (part.input as { command?: DeviceCommand } | undefined)?.command;
      const executed = status === "executed";
      return (
        <section className="card" data-tone={executed ? "success" : undefined} aria-label="Device action result">
          <div className="card-header">
            <div>
              <span className="kicker">Device action</span>
              <h3 className="card-title">{executed ? "Carried out" : humanize(status || "Update")}</h3>
            </div>
            <span className="badge" data-tone={executed ? "ok" : status === "rejected" ? undefined : "act"}>
              {humanize(status || "unknown")}
            </span>
          </div>
          {command && <div className="command">{describeCommand(command)}</div>}
          {(() => {
            const msg = (output?.result as { message?: string } | undefined)?.message ?? output?.message;
            return typeof msg === "string" ? <p className="card-sub">{msg}</p> : null;
          })()}
        </section>
      );
    }
    default:
      return null; // getStatus and others feed the sidebar instead.
  }
}
