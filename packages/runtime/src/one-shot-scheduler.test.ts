/**
 * 功能概述：验证 Runtime 生命周期与 durable one-shot scheduler 的装配边界。
 * 主要职责：覆盖启动恢复阻塞、关闭顺序和 synthetic debounce/wait 恢复的回归场景。
 * 代码库关系：直接消费 runtime 公共入口和 scheduler 公共能力；不依赖 apps composition。
 * 输入输出与副作用：测试数据库、clock 与 runtime 进程生命周期，不模拟模块层 agent。
 */
import { createTestingDatabase } from "@kaguya/database/testing";
import { KaguyaLlmClient } from "@kaguya/llm/client";
import {
  createFirstPartyModuleCatalog,
  createFirstPartyModuleActivations,
  createFirstPartyModuleConfigDefaults,
} from "@kaguya/modules";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import { modelTaskCapability } from "./model-task.js";
import {
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
  modelTaskCompletedInformationKind,
  modelTaskFailedInformationKind,
  modelTaskCancelledInformationKind,
} from "./information-kinds.js";
import { executionExhaustedInformationKind } from "@kaguya/engine";
import {
  oneShotScheduleCapability,
  type OneShotScheduleCapability,
} from "@kaguya/scheduler";
import { afterEach, describe, expect, it } from "vitest";

import {
  KaguyaRuntime,
  RuntimeUnavailableError,
  type RuntimeCapabilityContext,
} from "./index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

describe("KaguyaRuntime one-shot scheduler lifecycle", () => {
  it("commits a schedule through the runtime capability", async () => {
    const database = await createTestingDatabase();
    let capability: OneShotScheduleCapability | undefined;
    let id = 0;
    const runtime = new KaguyaRuntime({
      database,
      catalog: createFirstPartyModuleCatalog({
        modelTaskCapability,
        modelTaskCompletedInformationKind,
        modelTaskFailedInformationKind,
        modelTaskCancelledInformationKind,
        deliveryDeliveredInformationKind,
        deliveryFailedInformationKind,
        executionExhaustedInformationKind,
      }),
      activations: [],
      informationIdGenerator: () => `runtime-scheduler-${++id}`,
      capabilities: ({ oneShotSchedule }) => {
        capability = oneShotSchedule;
        return [
          { capability: oneShotScheduleCapability, value: oneShotSchedule },
        ];
      },
    });
    cleanups.push(async () => {
      await runtime.close();
      await database.close();
    });
    await runtime.start();
    const source = await runtime.submit({
      adapterId: "web.ui",
      platform: "web",
      platformMessageId: "source-1",
      occurredAt: "2026-09-06T12:00:00.000Z",
      text: "source",
      mentions: [],
      target: { kind: "web" },
      sender: { userId: "user-1" },
      raw: {},
    });
    const receipt = await capability!.schedule({
      operationKey: "runtime-schedule-1",
      sourceInformationId: source.rootInformationId,
      dueAt: "2099-01-01T00:00:00.000Z",
      input: { value: { nested: [1, true, null] } },
      activation: {
        instanceId: "test.schedule",
        definitionId: "test.schedule.synthetic",
      },
    });
    expect(receipt.created).toBe(true);
    expect(
      (await database.information.get(receipt.scheduleInformationId))?.kind,
    ).toBe("core.schedule.one-shot.requested");
  });

  it("does not accept ingress until overdue schedule recovery completes", async () => {
    const recovery = deferred<void>();
    const model = createRepeatingDeterministicModel({ text: "done" });
    const catalog = createFirstPartyModuleCatalog({
      modelTaskCapability,
      modelTaskCompletedInformationKind,
      modelTaskFailedInformationKind,
      modelTaskCancelledInformationKind,
      deliveryDeliveredInformationKind,
      deliveryFailedInformationKind,
      executionExhaustedInformationKind,
    });
    const runtime = new KaguyaRuntime({
      database: await createTestingDatabase(),
      catalog,
      activations: createFirstPartyModuleActivations(
        catalog,
        createFirstPartyModuleConfigDefaults("production"),
      ),
      modelTask: {
        approvals: [
          {
            activation: {
              instanceId: "reply.default",
              definitionId: "demo.reply.llm",
            },
            selectionPolicy: { tier: "heavy" },
          },
        ],
        client: new KaguyaLlmClient({ model }),
        resolveModel: () => ({
          providerId: "test-provider",
          modelId: "test-model",
        }),
      },
      oneShotRecoveryGate: recovery.promise,
      capabilities: ({ oneShotSchedule }: RuntimeCapabilityContext) => [
        { capability: oneShotScheduleCapability, value: oneShotSchedule },
      ],
    } as never);
    cleanups.push(() => runtime.close());
    const starting = runtime.start();
    await Promise.resolve();
    await expect(
      runtime.submit({
        adapterId: "web.ui.main",
        platform: "web",
        platformMessageId: "request-1",
        occurredAt: "2026-09-06T12:00:00.000Z",
        text: "hello",
        mentions: [],
        target: { kind: "web" },
        sender: { userId: "web" },
        raw: {},
      }),
    ).rejects.toThrow(RuntimeUnavailableError);
    recovery.resolve();
    await starting;
  });
});
