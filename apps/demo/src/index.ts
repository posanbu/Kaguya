/**
 * 功能概述：提供一个可执行、可测试的 PostgreSQL information DAG demo，
 * 用固定展示消息运行 Runtime 默认链，并输出根 `informationId` 与各 kind 计数。
 * 主要职责：`readDemoDatabaseUrl` 从 selected Profile 读取 runtime 数据库；`runDemo`
 * 注册固定 Web transport，通过 `runtime.submit` 提交输入，查询 context 相关的所有
 * 派生原子并输出排序后计数；生产默认使用 UUID，测试可注入确定性 ID；`main` 负责连接/关闭数据库。
 * 代码库关系：Runtime 业务装配统一来自 @kaguya/composition；数据库连接与 Server 使用同一 `KaguyaDatabase` 入口，
 * Web 正规化器来自 platform-adapters，Runtime 是唯一 Core ingress 实现与 DAG 组合者。
 * 输入输出与副作用：CLI 会建立一个 PostgreSQL 连接、准备 schema、写入账本并输出统计；
 * 连接或运行失败只输出安全错误类型，不回显数据库 URL 或原始异常。
 */
import { createMessageComposition } from "@kaguya/composition";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FileUserConfigManager,
  loadModuleInstanceConfigs,
} from "@kaguya/config";
import { KaguyaDatabase } from "@kaguya/database";
import {
  createFirstPartyModuleConfigDefaults,
  type FirstPartyModuleInstanceConfig,
} from "@kaguya/modules";
import {
  normalizeWebInboundMessage,
  type InboundReceipt,
} from "@kaguya/platform-adapters";
import { KaguyaRuntime } from "@kaguya/runtime";

export interface RunDemoOptions {
  readonly database: KaguyaDatabase;
  readonly moduleConfigs: readonly FirstPartyModuleInstanceConfig[];
  readonly writeLine?: (line: string) => void;
  readonly informationIdGenerator?: () => string;
}

const defaultConfigRoot = fileURLToPath(
  new URL("../../../.data/kaguya-config", import.meta.url),
);

export async function readDemoDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configRoot =
    environment.KAGUYA_CONFIG_ROOT?.trim() || defaultConfigRoot;
  const readiness = await FileUserConfigManager.inspect({
    rootDir: configRoot,
  });
  if (readiness.status === "setup_required") {
    throw new Error("Selected Profile runtime is required");
  }
  const manager = await FileUserConfigManager.open({ rootDir: configRoot });
  const profile = await manager.getProfile(manager.getSelectedProfileId());
  if (profile.runtime === undefined) {
    throw new Error("Selected Profile runtime is required");
  }
  return profile.runtime.databaseUrl;
}

export async function runDemo(
  options: RunDemoOptions,
): Promise<InboundReceipt> {
  const runtime = new KaguyaRuntime({
    ...createMessageComposition(undefined, {
      moduleConfigs: options.moduleConfigs,
    }),
    database: options.database,
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    informationIdGenerator: options.informationIdGenerator ?? randomUUID,
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
    const deadline = Date.now() + 10_000;
    const terminalKinds = new Set([
      "agent.turn.completed",
      "agent.turn.waiting",
      "agent.turn.silent",
      "agent.turn.failed",
      "agent.turn.superseded",
    ]);
    while (true) {
      const health = await options.database.information.reliable.health();
      const currentGraph = await options.database.information.query({
        informationId: receipt.rootInformationId,
      });
      if (
        health.pending === 0 &&
        currentGraph.some(({ kind }) => terminalKinds.has(kind))
      )
        break;
      if (Date.now() >= deadline)
        throw new Error("Demo delivery did not settle within ten seconds");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
  const configRoot = readDemoConfigRoot();
  const moduleConfigs = await loadModuleInstanceConfigs({
    rootDir: configRoot,
    defaults: createFirstPartyModuleConfigDefaults("production"),
  });
  const database = await KaguyaDatabase.connect({
    connectionString: await readDemoDatabaseUrl(),
  });
  try {
    await runDemo({ database, moduleConfigs });
  } finally {
    await database.close();
  }
}

function readDemoConfigRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.KAGUYA_CONFIG_ROOT?.trim() || defaultConfigRoot;
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
