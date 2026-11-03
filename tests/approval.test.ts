import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { SandboxDeviceAdapter } from "@/lib/devices/sandbox";
import { MemoryStateStore } from "@/lib/storage/memory";
import { minimalDesign, mockAdapter, purifierOn, reply, setup, toolCall } from "./helpers";


const toolResults = (msgs: Array<{ role: string }>) =>
  (msgs.filter((m) => m.role === "tool") as unknown as Array<{ tool_call_id: string; content: string }>).map((m) => ({
    id: m.tool_call_id,
    body: JSON.parse(m.content),
  }));

describe("approval gate", () => {
  it("pauses on executeDeviceAction, persists a pending approval, and never calls the adapter", async () => {
    const { adapter, execute } = mockAdapter();
    const call = toolCall("executeDeviceAction", purifierOn);
    const { runner, store, model } = setup({ steps: [reply("Requesting approval.", [call])], adapter });
    const s = await runner.createSession({});
    const run = await runner.sendMessage(s.id, "turn up my purifier");

    expect(run.status).toBe("awaiting_approval");
    expect(run.pendingApprovals).toHaveLength(1);
    const approval = run.pendingApprovals[0]!;
    expect(approval.status).toBe("pending");
    expect(approval.toolCallId).toBe(call.id);
    expect(execute).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);

    expect((await store.getApproval(approval.id))?.status).toBe("pending");
    const session = await runner.getSession(s.id);
    expect(session.status).toBe("awaiting_approval");
    expect(session.pendingTurn?.approvalIds).toEqual([approval.id]);
    // History must not yet contain a tool result for the gated call.
    expect(session.messages.filter((m) => m.role === "tool")).toHaveLength(0);

    await expect(runner.sendMessage(s.id, "another message")).rejects.toMatchObject({ code: "conflict" });
  });

  it("approve executes exactly once, activates the intervention, and resumes the loop", async () => {
    const { adapter, execute } = mockAdapter();
    const design = toolCall("designIntervention", minimalDesign);
    const { runner, store, model } = setup({
      steps: [
        reply(null, [design]),
        (req) => {
          const res = JSON.parse((req.messages.at(-1) as { content: string }).content);
          return reply(null, [toolCall("executeDeviceAction", { ...purifierOn, interventionId: res.interventionId })]);
        },
        reply("Purifier set to 80%."),
      ],
      adapter,
    });
    const s = await runner.createSession({});
    const paused = await runner.sendMessage(s.id, "plan my bedroom");
    expect(paused.status).toBe("awaiting_approval");
    const approval = paused.pendingApprovals[0]!;
    expect(approval.interventionId).toMatch(/^int_/);
    expect((await store.getIntervention(approval.interventionId!))?.status).toBe("proposed");

    const { approval: decided, run } = await runner.decideApproval(approval.id, "approve", { decidedBy: "duke" });
    expect(decided.status).toBe("executed");
    expect(decided.decidedBy).toBe("duke");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual(purifierOn.command);
    expect(run.status).toBe("completed");
    expect(run.reply).toBe("Purifier set to 80%.");

    const results = toolResults(model.requests[2]!.messages);
    const gated = results.find((r) => r.id === approval.toolCallId)!;
    expect(gated.body).toMatchObject({ status: "executed", executed: true, approvedBy: "duke" });
    expect((await store.getIntervention(approval.interventionId!))?.status).toBe("active");
    expect((await runner.getSession(s.id)).pendingTurn).toBeUndefined();

    // Second decision on the same approval is refused.
    await expect(runner.decideApproval(approval.id, "approve")).rejects.toMatchObject({ code: "conflict" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reject never executes and tells the model not to retry", async () => {
    const { adapter, execute } = mockAdapter();
    const { runner, model } = setup({
      steps: [reply(null, [toolCall("executeDeviceAction", purifierOn)]), reply("Understood, left it alone.")],
      adapter,
    });
    const s = await runner.createSession({});
    const paused = await runner.sendMessage(s.id, "turn up my purifier");
    const { approval, run } = await runner.decideApproval(paused.pendingApprovals[0]!.id, "reject", {
      note: "too loud at night",
    });
    expect(approval.status).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
    expect(run.status).toBe("completed");
    const [res] = toolResults(model.requests[1]!.messages);
    expect(res!.body).toMatchObject({ status: "rejected", executed: false, reason: "too loud at night" });
  });

  it("expired approvals are not executed", async () => {
    let t = Date.parse("2026-11-03T10:00:00Z");
    const { adapter, execute } = mockAdapter();
    const { runner, model } = setup({
      steps: [reply(null, [toolCall("executeDeviceAction", purifierOn)]), reply("The request expired.")],
      adapter,
      env: { APPROVAL_TTL_MINUTES: "5" },
      now: () => new Date(t),
    });
    const s = await runner.createSession({});
    const paused = await runner.sendMessage(s.id, "purifier");
    const id = paused.pendingApprovals[0]!.id;
    t += 6 * 60_000;
    expect((await runner.getApproval(id)).status).toBe("expired");
    const { approval } = await runner.decideApproval(id, "approve");
    expect(approval.status).toBe("expired");
    expect(execute).not.toHaveBeenCalled();
    const [res] = toolResults(model.requests[1]!.messages);
    expect(res!.body).toMatchObject({ status: "expired", executed: false });
  });

  it("waits for every approval in a parallel turn and keeps tool results in call order", async () => {
    const { adapter, execute } = mockAdapter();
    const status = toolCall("getStatus", {});
    const a = toolCall("executeDeviceAction", purifierOn);
    const b = toolCall("executeDeviceAction", {
      command: { deviceType: "window", deviceId: "cover.bedroom_window", action: "close" },
      reason: "Keep polluted outdoor air out overnight.",
    });
    const { runner, model } = setup({ steps: [reply(null, [status, a, b]), reply("Done.")], adapter });
    const s = await runner.createSession({});
    const paused = await runner.sendMessage(s.id, "secure the bedroom");
    expect(paused.pendingApprovals).toHaveLength(2);
    const [pa, pb] = paused.pendingApprovals;

    const first = await runner.decideApproval(pb!.id, "approve");
    expect(first.run.status).toBe("awaiting_approval");
    expect(first.run.pendingApprovals.map((p) => p.id)).toEqual([pa!.id]);
    expect(model.requests).toHaveLength(1);

    const second = await runner.decideApproval(pa!.id, "reject");
    expect(second.run.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolResults(model.requests[1]!.messages).map((r) => r.id)).toEqual([status.id, a.id, b.id]);
  });

  it("marks the approval failed when the adapter throws, and still resumes", async () => {
    const { adapter } = mockAdapter(async () => {
      throw new AppError("upstream_error", "device offline");
    });
    const { runner, model } = setup({
      steps: [reply(null, [toolCall("executeDeviceAction", purifierOn)]), reply("The device is offline.")],
      adapter,
    });
    const s = await runner.createSession({});
    const paused = await runner.sendMessage(s.id, "purifier");
    const { approval, run } = await runner.decideApproval(paused.pendingApprovals[0]!.id, "approve");
    expect(approval.status).toBe("failed");
    expect(approval.result?.message).toMatch(/device offline/);
    expect(run.status).toBe("completed");
    expect(toolResults(model.requests[1]!.messages)[0]!.body).toMatchObject({ status: "failed", executed: false });
  });

  it("refuses approvals for an unknown intervention", async () => {
    const { adapter } = mockAdapter();
    const { runner, store } = setup({
      steps: [reply(null, [toolCall("executeDeviceAction", { ...purifierOn, interventionId: "int_nope" })]), reply("ok")],
      adapter,
    });
    const s = await runner.createSession({});
    const run = await runner.sendMessage(s.id, "purifier");
    expect(run.status).toBe("completed");
    expect(run.toolCalls[0]!.outcome).toBe("error");
    expect(await store.listApprovals(s.id)).toHaveLength(0);
  });

  it("rejects invalid device commands before an approval is created", async () => {
    const { adapter } = mockAdapter();
    const { runner, store } = setup({
      steps: [
        reply(null, [
          toolCall("executeDeviceAction", {
            command: { deviceType: "hvac", deviceId: "climate.home", action: "set_temperature" },
            reason: "Cool down the room",
          }),
        ]),
        reply("ok"),
      ],
      adapter,
    });
    const s = await runner.createSession({});
    const run = await runner.sendMessage(s.id, "cool it");
    expect(run.toolCalls[0]!.outcome).toBe("error");
    expect(await store.listApprovals(s.id)).toHaveLength(0);
  });

  it("returns not_found for unknown approvals", async () => {
    const { runner } = setup({ steps: [] });
    await expect(runner.decideApproval("apr_missing", "approve")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("sandbox adapter", () => {
  it("persists simulated device state without seeded devices", async () => {
    const store = new MemoryStateStore();
    const adapter = new SandboxDeviceAdapter(store);
    expect(await adapter.getStates("ses_1")).toEqual([]);
    const res = await adapter.execute(purifierOn.command as never, { sessionId: "ses_1", approvalId: "apr_1" });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/SANDBOX/);
    const [state] = await adapter.getStates("ses_1");
    expect(state).toMatchObject({ deviceId: "fan.bedroom_purifier", power: "on", fanSpeedPercent: 80 });
  });
});
