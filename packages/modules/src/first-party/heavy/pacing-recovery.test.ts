/**
 * 功能概述：在真实 Core 和 PGlite 账本上验证长时间离线后的表达节奏恢复。
 * 主要职责：重建 Core 后运行 Heavy 的到期 handler，检查静默、调度完成和重放幂等。
 * 代码库关系：使用生产 Heavy、情境选择器和静默契约；handler 上下文复现 ModuleHost 因果限制。
 * 输入输出与副作用：只登记合成事实，不调用模型或平台；每次测试关闭 Core 与数据库。
 */
import { expect, it, vi } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import { InformationCore, InformationKindRegistry } from "@kaguya/engine";
import { defineInformationKind, defineModuleCapability } from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import {
  oneShotScheduleCapability,
  oneShotRequestedInformationKind,
  oneShotDueInformationKind,
} from "@kaguya/scheduler";
import {
  assistantTextInformationKind,
  heavyResponseSilentInformationKind,
} from "../kinds/message.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { createHeavyModule } from "./index.js";
import { identity, target } from "./test-fixtures.js";
import { speechReadyInformationKind } from "./speech.js";

const fake = (kind: string, refs = {}) =>
  defineInformationKind({
    kind,
    displayName: kind,
    description: "Synthetic persisted fixture",
    payloadSchema: z.record(z.string(), z.json()),
    references: refs,
    log: { enabled: false },
  });
const runtime = fake("core.runtime.context");
const completed = fake("core.model.task.completed");
const intent = fake("agent.router.message.intent.requested");
const candidate = fake("agent.heartbeat.candidate");
const claim = fake("agent.router.turn.claimed");
const turnContext = fake("agent.router.turn.context.completed");
const token = defineModuleCapability("kaguya:model-task", 1);
const activation = { instanceId: "heavy.default", definitionId: "agent.heavy" };
const base = { occurredAt: "2026-01-01T00:00:00.000Z", source: "test:pacing" };

it("expires a persisted overdue speech once after Core reconstruction", async () => {
  const db = await createTestingDatabase();
  let core: InformationCore | undefined;
  try {
    await db.prepareSchema();
    const registry = new InformationKindRegistry();
    for (const kind of [runtime, completed, assistantTextInformationKind])
      registry.registerBuiltin(kind);
    for (const kind of [
      intent,
      candidate,
      claim,
      turnContext,
      speechReadyInformationKind,
      heavyResponseSilentInformationKind,
    ])
      registry.register(kind);
    let next = 0;
    const open = async () => {
      const current = new InformationCore({
        registry,
        store: db.information,
        nextInformationId: () => `pacing-${++next}`,
      });
      await current.start();
      return current;
    };
    core = await open();
    const register = (kind: any, payload: any, references: any[] = []) =>
      core!.register(kind, { ...base, payload, references });
    const ctx = await register(runtime, {});
    const c = await register(candidate, {});
    const cl = await register(claim, {});
    const t = await register(turnContext, {});
    const i = await register(intent, {});
    const done = await register(completed, {});
    const turn = {
      candidateInformationId: c.informationId,
      claimInformationId: cl.informationId,
      contextInformationId: t.informationId,
    };
    const ready = await register(
      speechReadyInformationKind,
      {
        text: "old reply",
        source: target,
        originatingModuleInstanceId: activation.instanceId,
        turn,
        speech: {
          intentInformationId: i.informationId,
          stepInformationId: i.informationId,
          stepIndex: 0,
          completedInformationId: done.informationId,
          continuation: null,
          readyAt: base.occurredAt,
        },
      },
      [
        { relation: "core:context", informationId: ctx.informationId },
        { relation: "core:caused-by", informationId: done.informationId },
      ],
    );
    const arm = await register(
      oneShotRequestedInformationKind,
      {
        operationKey: "heavy-speech:test",
        dueAt: base.occurredAt,
        activation,
        input: {
          purpose: "heavy-speech",
          readyInformationId: ready.informationId,
        },
      },
      [{ relation: "core:caused-by", informationId: ready.informationId }],
    );
    const due = await register(
      oneShotDueInformationKind,
      {
        scheduleInformationId: arm.informationId,
        dueAt: base.occurredAt,
        deliveredAt: "2026-01-01T00:05:01.000Z",
      },
      [{ relation: "core:status-of", informationId: arm.informationId }],
    );
    await core.close();
    core = await open();
    const finish = vi.fn(async () => {});
    const context = {
      sourceAtom: due,
      instanceId: activation.instanceId,
      definitionId: activation.definitionId,
      signal: new AbortController().signal,
      now: () => new Date("2026-01-01T00:05:01.000Z"),
      report: vi.fn(),
      select: (selector: any) => core!.select(selector, due.informationId),
      use: (capability: { id: string }) =>
        capability.id === oneShotScheduleCapability.id ? { finish } : {},
      registerOnce: async (
        operation: string,
        key: string,
        kind: any,
        input: any,
      ) => {
        if (
          input.causedByInformationId !== undefined &&
          !due.references.some(
            (ref: any) =>
              ref.relation === "core:caused-by" &&
              ref.informationId === input.causedByInformationId,
          )
        )
          throw new Error(
            "Module causal passthrough must use the source atom's direct cause",
          );
        return core!.registerOnce(operation, key, kind, {
          occurredAt: "2026-01-01T00:05:01.000Z",
          source: `module:${activation.instanceId}`,
          payload: input.payload,
          references: [
            {
              relation: "core:caused-by",
              informationId: input.causedByInformationId ?? due.informationId,
            },
            {
              relation: "core:context",
              informationId: input.contextInformationId,
            },
            ...(input.references ?? []),
          ],
        });
      },
    } as any;
    const definition = createHeavyModule({
      modelTaskCapability: token as any,
      modelTaskCompletedInformationKind: completed as any,
      promptTemplates: loadFirstPartyPromptTemplates().heavy,
      agentIdentity: identity,
    });
    const instance = await definition.create(
      { ...activation, activation, settings: {} } as any,
      context,
    );
    const handler = instance.subscriptions.find(
      (sub) => sub.subscriptionId === "kaguya.heavy.pacing-due",
    )!;
    await handler.handle(due as never, context);
    await handler.handle(due as never, context);
    expect(
      await core.find({
        kinds: [assistantTextInformationKind.kind],
        limit: 10,
      }),
    ).toHaveLength(0);
    const silent = await core.find({
      kinds: [heavyResponseSilentInformationKind.kind],
      limit: 10,
    });
    expect(silent).toHaveLength(1);
    expect(silent[0]!.payload).toMatchObject({
      intentInformationId: i.informationId,
      turn,
    });
    expect(finish).toHaveBeenCalledWith({
      scheduleInformationId: arm.informationId,
      status: "fired",
    });
  } finally {
    await core?.close();
    await db.close();
  }
});
