/**
 * 功能概述：认知模块测试的真实 PGlite、Core 与 ModuleHost 夹具，验证引用校验、幂等槽与调度持久化。
 * cognitiveFixture 装配显式模块和时钟；模型替身只替换外部生成，结果仍通过 Core 持久化去重。
 * restart 关闭并重建宿主和 Core，保留数据库；close 由测试 finally 调用，不连接真实模型或平台。
 */
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
} from "@kaguya/engine";
import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  defineModuleCapability,
  defineInformationModuleCatalog,
  catalogInformationKinds,
  type InformationModuleDefinition,
} from "@kaguya/sdk";
import {
  OneShotScheduleClient,
  oneShotScheduleCapability,
} from "@kaguya/scheduler";
import type {
  ModelTaskCapability,
  ModelTaskRequest,
} from "../message-composer/index.js";
import * as kinds from "../information-kinds.js";
export const modelToken = defineModuleCapability<ModelTaskCapability>(
  "kaguya:model-task",
  1,
);
const runtimeKind = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "测试上下文",
  description: "为认知模块测试提供独立运行上下文与可追溯的输入边界。",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const modelResult = defineInformationKind({
  kind: "core.test.model.result",
  displayName: "测试模型结果",
  description: "外部模型替身的持久化结果",
  payloadSchema: z
    .object({
      output: z.json(),
      status: z.enum(["completed", "failed", "cancelled"]),
    })
    .strict(),
  references: { "core:caused-by": { required: true, multiple: false } },
  log: { enabled: false },
});
export async function cognitiveFixture(
  modules: InformationModuleDefinition[],
  generate: (request: ModelTaskRequest<unknown>) => unknown = () => ({
    patterns: [],
  }),
) {
  const database = await createTestingDatabase();
  await database.prepareSchema();
  let seq = 0;
  let now = "2026-09-09T00:00:10.000Z";
  let core: InformationCore;
  let host: ModuleHost;
  let calls = 0;
  const catalog = defineInformationModuleCatalog(...modules);
  const configs = modules.map((m) => ({
    instanceId: m.manifest.definitionId + ".test",
    definitionId: m.manifest.definitionId,
    settings: m.manifest.settingsSchema.parse(
      m.manifest.definitionId === "agent.expression" ? { batchSize: 2 } : {},
    ),
  }));
  async function start() {
    const registry = new InformationKindRegistry();
    const defs = [
      runtimeKind,
      modelResult,
      ...Object.values(kinds).filter(
        (v): v is any => typeof v === "object" && v !== null && "kind" in v,
      ),
      ...catalogInformationKinds(catalog),
    ];
    const seen = new Set();
    for (const d of defs) {
      if (
        seen.has(d.kind) ||
        d.kind.startsWith("core.schedule.") ||
        d.kind === "execution.exhausted" ||
        d.kind === "consumer.failed"
      )
        continue;
      seen.add(d.kind);
      if (d.kind.startsWith("core.")) registry.registerBuiltin(d);
      else registry.register(d);
    }
    core = new InformationCore({
      registry,
      store: database.information,
      nextInformationId: () => `cognitive-${++seq}`,
      now: () => new Date(now),
    });
    const model = {
      execute: async (request: ModelTaskRequest<unknown>) => {
        const existing = (
          await database.information.find({
            kinds: [modelResult.kind],
            limit: 1000,
          })
        ).find((a) =>
          a.references.some(
            (r) => r.informationId === request.sourceInformationId,
          ),
        );
        let terminal = existing;
        if (!terminal) {
          calls++;
          const output = generate(request);
          terminal = await core.registerOnce(
            "test.model",
            request.sourceInformationId,
            modelResult,
            {
              source: "core:test",
              occurredAt: "2026-09-09T00:00:10.000Z",
              payload: { output: output as any, status: "completed" as const },
              references: [
                {
                  relation: "core:caused-by",
                  informationId: request.sourceInformationId,
                },
              ],
            },
          );
        }
        return {
          status: "completed",
          output: terminal.payload.output,
          requestedInformationId: request.sourceInformationId,
          terminalInformationId: terminal.informationId,
        };
      },
      cancel: async () => undefined,
    };
    host = new ModuleHost({
      core,
      catalog,
      capabilities: [
        {
          capability: modelToken,
          value: model as unknown as ModelTaskCapability,
        },
        {
          capability: oneShotScheduleCapability,
          value: new OneShotScheduleClient(core),
        },
      ],
    });
    await core.start();
    await host.start(configs);
  }
  await start();
  return {
    database,
    get core() {
      return core;
    },
    get calls() {
      return calls;
    },
    setNow(value: string) {
      now = value;
    },
    async restart() {
      await host.stop();
      await core.close();
      await start();
    },
    async close() {
      await host.stop();
      await core.close();
      await database.close();
    },
    async context() {
      return core.register(runtimeKind, {
        source: "core:test",
        occurredAt: "2026-09-09T00:00:10.000Z",
        payload: {},
        references: [],
      });
    },
    async all(kind?: string) {
      return database.information.find({
        ...(kind
          ? { kinds: [kind] }
          : { occurredAfter: "2026-09-08T00:00:00.000Z" }),
        limit: 1000,
      });
    },
  };
}
