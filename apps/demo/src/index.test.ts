/**
 * 功能概述：验证 demo 以 PostgreSQL information ledger 运行确定性入站 DAG，
 * 输出根 `informationId` 和每个衍生 kind 的计数，不再使用 SQLite path 或 dispatch。
 * 主要职责：覆盖 `KAGUYA_DATABASE_URL` 必填校验，并用真实内存 PGlite
 * 运行 Web 消息的 context、inbound、reply、LLM、assistant 与 delivery 链。
 * 代码库关系：直接调用 `index.ts` 导出的 `readDemoDatabaseUrl`/`runDemo`；
 * 测试数据库来自 `@kaguya/database/testing`，实际 CLI 则由同一 URL 连接方式启动。
 * 输入输出与副作用：用例收集内存输出行并显式关闭 PGlite；
 * 每次执行使用固定消息与可预测 ID，不调用外部平台或模型。
 */
import { createTestingDatabase } from "@kaguya/database/testing";
import { afterEach, describe, expect, it } from "vitest";

import { readDemoDatabaseUrl, runDemo } from "./index.js";

const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    databases.splice(0).map((database) => database.close()),
  );
});

describe("demo entry point", () => {
  it("requires the shared PostgreSQL database URL", () => {
    expect(() => readDemoDatabaseUrl({})).toThrow(
      "KAGUYA_DATABASE_URL is required",
    );
    expect(
      readDemoDatabaseUrl({
        KAGUYA_DATABASE_URL: " postgresql://db.example/kaguya ",
      }),
    ).toBe("postgresql://db.example/kaguya");
  });

  it("submits one deterministic message and prints its information kind counts", async () => {
    const database = await createTestingDatabase();
    databases.push(database);
    const output: string[] = [];

    const receipt = await runDemo({
      database,
      writeLine: (line) => output.push(line),
    });

    expect(receipt.rootInformationId).toBe("demo-information-1");
    expect(output).toEqual([
      "root informationId: demo-information-1",
      "core.delivery.delivered: 1",
      "core.delivery.requested: 1",
      "core.llm.completed: 1",
      "core.llm.requested: 1",
      "core.message.assistant.text: 1",
      "core.message.inbound.text: 1",
      "core.reply.requested: 1",
      "core.runtime.context: 1",
    ]);
  }, 20_000);
});
