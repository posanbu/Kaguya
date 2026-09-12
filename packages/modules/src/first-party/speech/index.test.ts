/**
 * 功能概述：验证 Planner 真实 handler 的取消、严格输出和重放契约。
 * setup 使用冻结消息样本和受限 handler context，真实编译器保留 provenance；仅替换 Model Task 能力。
 * 主要职责：检查非 eligible 不调用模型、取消 fail-closed、等待预算共享与已落账 Prompt 的稳定重放。
 * 输入输出与副作用：记录 execute/commitTerminal 参数，不访问网络或数据库；Runtime 集成另覆盖持久化链。
 */
import { describe, it, expect, vi } from "vitest";
import {
  defineModuleCapability,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import type {
  ModelTaskCapability,
  ModelTaskRequest,
} from "../message-composer/index.js";
import { atom, fixture, identity } from "../message-composer/test-fixtures.js";
import { createSpeechModule } from "./index.js";

async function setup(
  outcome = "attend",
  result: unknown = {
    status: "cancelled",
    terminalInformationId: "cancelled-1",
  },
) {
  const f = fixture();
  const gate = atom(
    "gate-1",
    "agent.attention.arousal.completed",
    {
      outcome,
      turnContextInformationId: f.turn.informationId,
      claimInformationId: "claim-1",
      candidateInformationId: "candidate-1",
      attempt: 0,
      totalWaitBudget: 3,
      reasonCodes: ["score-below-threshold"],
      dueAt: "2026-09-09T00:00:17.000Z",
      delayMs: 15000,
    },
    [{ relation: "core:context", informationId: "runtime-context" }],
  );
  const execute = vi.fn(async (_request: ModelTaskRequest<unknown>) => result);
  const commitTerminal = vi.fn(async () => gate);
  const selected = [gate, f.turn, ...f.messages];
  const context = {
    select: vi.fn(async () => selected),
    use: () => ({ execute }),
    commitTerminal,
  } as unknown as InformationModuleHandlerContext;
  const definition = createSpeechModule({
    modelTaskCapability: defineModuleCapability<ModelTaskCapability>(
      "kaguya:model-task",
      1,
    ),
    agentIdentity: identity,
  });
  const activation = {
    instanceId: "speech.default",
    definitionId: "agent.speech.planner",
  };
  const instance = await definition.create(
    {
      instanceId: activation.instanceId,
      activation,
      settings: {
        modelTier: "light",
        policyDigest: "speech:planner-v1",
        settingsDigest: "speech:light-v1",
      },
    },
    context,
  );
  return {
    ...f,
    gate,
    selected,
    execute,
    commitTerminal,
    context,
    handle: () => instance.subscriptions[0]!.handle(gate as never, context),
    activation,
  };
}

describe("speech Planner handler", () => {
  it("converts explicit cancellation into silent without losing task causality", async () => {
    const s = await setup();
    await s.handle();
    expect(s.commitTerminal.mock.calls[0]).toMatchObject([
      "agent.turn.decision",
      "claim-1",
      { kind: "agent.speech.decision" },
      {
        payload: { outcome: "silent", reasonCodes: ["planner-unavailable"] },
        references: expect.arrayContaining([
          { relation: "core:uses-context", informationId: "cancelled-1" },
        ]),
      },
    ]);
  });
  it.each(["defer", "ignore"])(
    "%s does not create a Model Task",
    async (outcome) => {
      const s = await setup(outcome);
      await s.handle();
      expect(s.execute).not.toHaveBeenCalled();
      expect(s.commitTerminal.mock.calls[0]).toMatchObject([
        "agent.turn.decision",
        "claim-1",
        {},
        { payload: { outcome: outcome === "defer" ? "wait" : "silent" } },
      ]);
    },
  );
  it("reuses the persisted Prompt and atom order when backdated history arrives", async () => {
    const s = await setup();
    await s.handle();
    const first = s.execute.mock.calls[0]![0];
    s.selected.push(
      atom("backdated", "core.message.inbound.text", { text: "late history" }),
    );
    s.selected.push(
      atom("request-1", "core.model.task.requested", {
        taskId: "core.speech.plan",
        activation: s.activation,
        contextInformationIds: first.contextAtoms.map((a) => a.informationId),
        prompt: first.prompt as never,
      }),
    );
    await s.handle();
    const replay = s.execute.mock.calls[1]![0];
    expect(replay.prompt).toEqual(first.prompt);
    expect(replay.contextAtoms).toEqual(first.contextAtoms);
    expect(replay.prompt.text).not.toContain("late history");
  });
  it("does not turn a durable storage or shutdown interruption into a false silent decision", async () => {
    const s = await setup();
    s.execute.mockRejectedValue(new Error("execution interrupted"));
    await expect(s.handle()).rejects.toThrow("execution interrupted");
    expect(s.commitTerminal).not.toHaveBeenCalled();
  });
});
