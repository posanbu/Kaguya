/**
 * 功能概述：提供一个可执行、可测试的 PostgreSQL information DAG demo，
 * 用确定性 Web 消息运行 Runtime 默认链，并输出根 `informationId` 与各 kind 计数。
 * 主要职责：`readDemoDatabaseUrl` 要求共享 `KAGUYA_DATABASE_URL`；`runDemo`
 * 注册确定性 Web transport，通过 `runtime.submit` 提交固定输入，查询 context
 * 相关的所有派生原子并输出排序后计数；`main` 负责连接/关闭数据库。
 * 代码库关系：数据库连接与 Server 使用同一 `KaguyaDatabase` 入口，
 * Web 正规化器来自 platform-adapters，Runtime 是唯一 Core ingress 实现与 DAG 组合者。
 * 输入输出与副作用：CLI 会建立一个 PostgreSQL 连接、执行迁移/账本写入并输出统计；
 * 连接或运行失败只输出安全错误类型，不回显数据库 URL 或原始异常。
 */
import { pathToFileURL } from "node:url";

import { KaguyaDatabase } from "@kaguya/database";
import {
  normalizeWebInboundMessage,
  type InboundReceipt,
} from "@kaguya/platform-adapters";
import { KaguyaRuntime } from "@kaguya/runtime";

export interface RunDemoOptions {
  readonly database: KaguyaDatabase;
  readonly writeLine?: (line: string) => void;
}

export function readDemoDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const databaseUrl = environment.KAGUYA_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("KAGUYA_DATABASE_URL is required");
  }
  return databaseUrl;
}

export async function runDemo(
  options: RunDemoOptions,
): Promise<InboundReceipt> {
  let sequence = 0;
  const runtime = new KaguyaRuntime({
    database: options.database,
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    informationIdGenerator: () => `demo-information-${++sequence}`,
  });
  runtime.registerTransport({
    adapterId: "demo.web.main",
    platform: "web",
    transport: {
      sendMessage: async (target) => ({
        ok: true,
        adapterId: "demo.web.main",
        platform: "web",
        target,
        platformMessageId: "demo-delivery-1",
      }),
    },
  });
  await runtime.start();
  try {
    const inbound = normalizeWebInboundMessage(
      {
        requestId: "demo-request-1",
        text: "Is tonight good for watching the moon?",
      },
      {
        adapterId: "demo.web.main",
        now: () => new Date("2026-09-04T00:00:00.000Z"),
      },
    );
    if (inbound === undefined) {
      throw new Error("Demo web message is invalid");
    }
    const receipt = await runtime.submit(inbound);
    const graph = await options.database.information.query({
      informationId: receipt.rootInformationId,
    });
    const root = await options.database.information.get(
      receipt.rootInformationId,
    );
    if (root === undefined) {
      throw new Error("Demo root information is unavailable");
    }
    const counts = new Map<string, number>();
    for (const atom of [root, ...graph]) {
      counts.set(atom.kind, (counts.get(atom.kind) ?? 0) + 1);
    }
    const writeLine = options.writeLine ?? console.log;
    writeLine(`root informationId: ${receipt.rootInformationId}`);
    for (const [kind, count] of [...counts].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      writeLine(`${kind}: ${count}`);
    }
    return receipt;
  } finally {
    await runtime.close();
  }
}

async function main(): Promise<void> {
  const database = await KaguyaDatabase.connect({
    connectionString: readDemoDatabaseUrl(),
  });
  try {
    await runDemo({ database });
  } finally {
    await database.close();
  }
}

if (process.argv[1] !== undefined) {
  const entrypointUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entrypointUrl) {
    await main().catch((error: unknown) => {
      console.error(`Kaguya demo failed: ${safeErrorType(error)}`);
      process.exitCode = 1;
    });
  }
}

function safeErrorType(error: unknown): string {
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof Error) return error.constructor.name;
  return "UnknownError";
}
