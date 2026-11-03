"use client";

import type { AirQualitySnapshot, DeviceCommand, EngineeringChecks, HealthProfile, InterventionDesign } from "@/lib/domain";
import type { assessHealth } from "@/lib/agent/tools/getHealthContext";
import { AirQualityCard } from "./AirQualityCard";
import { HealthContextSummary } from "./HealthContextSummary";
import { InterventionPlanCard, describeCommand } from "./InterventionPlanCard";
import { humanize } from "../format";

export interface ToolPartView {
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

const TOOL_LABEL: Record<string, string> = {
  getAirQuality: "Checking air quality",
  getHealthContext: "Assessing health context",
  designIntervention: "Designing intervention",
  executeDeviceAction: "Preparing device action",
  getStatus: "Reviewing status",
};

function Pending({ name }: { name: string }) {
  return (
    <div className="card" aria-busy="true">
      <div className="loading">
        <span className="typing" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {TOOL_LABEL[name] ?? `Running ${name}`}…
      </div>
      <div className="skeleton" style={{ width: "70%" }} />
    </div>
  );
}

function ErrorCard({ name, message }: { name: string; message: string }) {
  return (
    <section className="card" data-tone="error" aria-label={`${name} failed`}>
      <div className="card-title">{humanize(TOOL_LABEL[name] ?? name)}: not available</div>
      <p style={{ fontSize: "var(--text-sm)" }}>{message}</p>
    </section>
  );
}

export function ToolResultCard({ part, history }: { part: ToolPartView; history?: Array<{ at: string; pm25?: number }> }) {
  const { toolName, state } = part;
  const output = part.output as Record<string, unknown> | undefined;

  if (state === "output-error") return <ErrorCard name={toolName} message={part.errorText ?? "The tool failed."} />;

  // executeDeviceAction waits for approval: the approval card renders it.
  if (toolName === "executeDeviceAction" && state !== "output-available") return null;
  if (state !== "output-available") return <Pending name={toolName} />;
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
    case "designIntervention":
      return (
        <InterventionPlanCard
          design={(part.input ?? {}) as Partial<InterventionDesign>}
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
            <div className="card-title">Device action</div>
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
