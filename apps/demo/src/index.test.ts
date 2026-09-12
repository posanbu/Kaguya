/**
 * 验证离线 Demo 的完整 DAG 统计；独立 Planner 与 Composer 各执行一个模型任务。
 * 功能概述：验证 demo 以 PostgreSQL information ledger 运行确定性入站 DAG，
 * 输出根 `informationId` 和每个衍生 kind 的计数，不再使用 SQLite path 或 dispatch。
 * 主要职责：覆盖 selected Profile runtime 读取与旧数据库环境变量忽略，并用真实内存 PGlite
 * 运行 Web 消息的 context、inbound、message intent、Model Task、assistant 与 delivery 链。
 * 代码库关系：直接调用 `index.ts` 导出的 `readDemoDatabaseUrl`/`runDemo`；
 * 测试数据库来自 `@kaguya/database/testing`，实际 CLI 则由同一 URL 连接方式启动。
 * 输入输出与副作用：用例收集内存输出行并显式关闭 PGlite；
 * 单次展示用例注入可预测 ID，重复运行用例验证生产 UUID 在同一持久账本不冲突；
 * 不调用外部平台或模型。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileUserConfigManager } from "@kaguya/config";
import { createTestingDatabase } from "@kaguya/database/testing";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { afterEach, describe, expect, it } from "vitest";

import { readDemoDatabaseUrl, runDemo } from "./index.js";

const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    databases.splice(0).map((database) => database.close()),
  );
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("demo entry point", () => {
  it("reads the selected Profile database and ignores retired environment variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-demo-config-"));
    roots.push(root);
    await expect(
      readDemoDatabaseUrl({ KAGUYA_CONFIG_ROOT: root }),
    ).rejects.toThrow("Selected Profile runtime is required");

    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    const profile = await manager.getProfile(manager.getSelectedProfileId());
    await manager.replaceProfile(profile.id, {
      name: profile.name,
      identity: profile.identity,
      acknowledgedWarnings: [],
      ai: profile.ai,
      memory: profile.memory,
      platforms: profile.platforms,
      runtime: demoRuntime,
    });

    await expect(
      readDemoDatabaseUrl({ KAGUYA_CONFIG_ROOT: ` ${root} ` }),
    ).resolves.toBe(demoRuntime.databaseUrl);
    await expect(
      readDemoDatabaseUrl({
        KAGUYA_CONFIG_ROOT: root,
        KAGUYA_DATABASE_URL: "postgresql://secret@legacy.example/kaguya",
      }),
    ).resolves.toBe(demoRuntime.databaseUrl);
  });

  it("submits one deterministic message and prints its information kind counts", async () => {
    const database = await createTestingDatabase();
    databases.push(database);
    const output: string[] = [];
    let sequence = 0;

    const receipt = await runDemo({
      database,
      moduleConfigs: createFirstPartyModuleConfigDefaults("test"),
      writeLine: (line) => output.push(line),
      informationIdGenerator: () => `demo-information-${++sequence}`,
    });

    expect(receipt.rootInformationId).toBe("demo-information-1");
    expect(output).toEqual([
      "root informationId: demo-information-1",
      "agent.association.completed: 1",
      "agent.association.query: 1",
      "agent.association.requested: 1",
      "agent.attention.arousal.completed: 1",
      "agent.chat.scope.binding: 1",
      "agent.chat.scope.entity: 1",
      "agent.heartbeat.scheduled: 1",
      "agent.message.intent.requested: 1",
      "agent.person.context.completed: 1",
      "agent.person.resolution: 1",
      "agent.speech.decision: 1",
      "agent.turn.candidate: 1",
      "agent.turn.claimed: 1",
      "agent.turn.completed: 1",
      "agent.turn.context.completed: 1",
      "agent.turn.started: 1",
      "core.delivery.delivered: 1",
      "core.delivery.requested: 1",
      "core.message.assistant.text: 1",
      "core.message.inbound.text: 1",
      "core.model.task.completed: 2",
      "core.model.task.requested: 2",
      "core.runtime.context: 1",
    ]);
  }, 20_000);

  it("can run twice against the same persistent ledger with production ids", async () => {
    const database = await createTestingDatabase();
    databases.push(database);

    const moduleConfigs = createFirstPartyModuleConfigDefaults("test");
    const first = await runDemo({
      database,
      moduleConfigs,
      writeLine: () => undefined,
    });
    const second = await runDemo({
      database,
      moduleConfigs,
      writeLine: () => undefined,
    });

    expect(first.rootInformationId).not.toBe(second.rootInformationId);
    expect(
      await database.information.get(first.rootInformationId),
    ).toBeDefined();
    expect(
      await database.information.get(second.rootInformationId),
    ).toBeDefined();
  }, 20_000);
});

const demoRuntime = {
  host: "127.0.0.1",
  port: 3000,
  databaseMode: "external" as const,
  databaseUrl: "postgresql://profile:secret@database.example/kaguya",
  webDistPath: "apps/web/dist",
  corsOrigins: [],
  trustProxy: false as const,
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
  logLevel: "info" as const,
  logFormat: "json" as const,
  gatewayAllowlist: [],
};
