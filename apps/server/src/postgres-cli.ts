/**
 * 功能概述：暴露 postgres:start/status/check、默认开发启动和真实 PostgreSQL 测试入口。
 * 主要职责：解析稳定命令与可选端口，尝试数据库准备后启动 Server，测试入口仍要求数据库就绪，并转发
 * SIGINT/SIGTERM；测试 URL 只注入子进程，普通输出不打印连接串或凭据。
 * 代码库关系：根 package scripts 调用构建后的本文件；生命周期实现在
 * postgres-development.ts，生产 pnpm start 不经过这里。
 * 输入输出与副作用：可能启动 Docker 容器、补齐 selected Profile runtime 或创建子进程；
 * 不停止/删除容器和数据卷。
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError } from "@kaguya/config";

import {
  readServerBootstrapConfig,
  ServerRuntimeConfigurationError,
} from "./config.js";
import {
  checkDevelopmentPostgres,
  checkManagedPostgresDatabase,
  checkPostgresTestDatabase,
  ensureDevelopmentPostgres,
  ensureManagedPostgres,
  PostgresDevelopmentError,
  readDevelopmentPostgresStatus,
} from "./postgres-development.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(serverRoot, "../..");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
export const POSTGRES_TEST_FILES = [
  "packages/database/src/postgres-information-ledger.test.ts",
  "packages/database/src/postgres-index.test.ts",
  "packages/database/src/postgres-reliable.test.ts",
  "packages/database/src/postgres-memory-store.test.ts",
  "packages/database/src/one-shot-schedule-repository.test.ts",
  "packages/runtime/src/model-task-persistence.test.ts",
] as const;

export async function runPostgresCli(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const command = args[0];
  const port = parsePostgresPort(args.slice(1));
  const bootstrap = readServerBootstrapConfig(process.env);
  if (command === "start") {
    const result = await ensureDevelopmentPostgres({
      configRoot: bootstrap.configRoot,
      ...(port === undefined ? {} : { port }),
    });
    process.stdout.write(`PostgreSQL ready (${result.mode})\n`);
    return 0;
  }
  if (command === "status") {
    const result = await readDevelopmentPostgresStatus({
      configRoot: bootstrap.configRoot,
    });
    const portText =
      result.status.port === undefined ? "" : ` port=${result.status.port}`;
    const versionText =
      result.status.postgresMajor === undefined
        ? " version=unknown"
        : ` version=${result.status.postgresMajor}`;
    process.stdout.write(
      `PostgreSQL mode=${result.mode} state=${result.status.state} healthy=${String(result.status.healthy)}${versionText}${portText}\n`,
    );
    return result.status.healthy ? 0 : 1;
  }
  if (command === "check") {
    const result = await checkDevelopmentPostgres({
      configRoot: bootstrap.configRoot,
    });
    process.stdout.write(`PostgreSQL check passed (${result.mode})\n`);
    return 0;
  }
  if (command === "dev") {
    try {
      await ensureDevelopmentPostgres({
        configRoot: bootstrap.configRoot,
        ...(port === undefined ? {} : { port }),
      });
    } catch (error) {
      if (!(error instanceof PostgresDevelopmentError)) {
        writePreparationFailure(error);
        return 1;
      }
      process.stderr.write(
        `Database preparation unavailable [${error.name}]: ${error.message}; Server will inspect configuration and start in degraded mode when possible.\n`,
      );
    }
    return spawnInteractive(
      pnpmExecutable,
      ["exec", "tsx", "src/server.ts"],
      serverRoot,
      { ...process.env, NODE_ENV: "development" },
    );
  }
  if (command === "test") {
    const explicitTestUrl = process.env.KAGUYA_TEST_DATABASE_URL?.trim();
    const databaseUrl =
      explicitTestUrl && explicitTestUrl.length > 0
        ? explicitTestUrl
        : (
            await ensureManagedPostgres({
              ...(port === undefined ? {} : { port }),
            })
          ).databaseUrl;
    if (explicitTestUrl) {
      await checkPostgresTestDatabase(databaseUrl);
    } else {
      await checkManagedPostgresDatabase(databaseUrl, { migrate: false });
    }
    await assertPostgresTestManifestComplete(repositoryRoot);
    return spawnInteractive(
      pnpmExecutable,
      ["exec", "vitest", "run", ...POSTGRES_TEST_FILES],
      repositoryRoot,
      {
        ...process.env,
        KAGUYA_REQUIRE_POSTGRES_TESTS: "1",
        KAGUYA_TEST_DATABASE_URL: databaseUrl,
      },
    );
  }
  throw new PostgresDevelopmentError(
    "Expected one of: start, status, check, dev, test",
  );
}

export async function assertPostgresTestManifestComplete(
  root: string,
): Promise<void> {
  const sources = (
    await Promise.all(
      ["packages", "apps"].map((directory) =>
        collectTestSources(resolve(root, directory)),
      ),
    )
  ).flat();
  const consumers: string[] = [];
  for (const source of sources) {
    if ((await readFile(source, "utf8")).includes("KAGUYA_TEST_DATABASE_URL")) {
      consumers.push(relative(root, source).replaceAll("\\", "/"));
    }
  }
  const registered = new Set<string>(POSTGRES_TEST_FILES);
  const missing = consumers.filter((source) => !registered.has(source));
  if (missing.length > 0) {
    throw new PostgresDevelopmentError(
      `PostgreSQL test manifest is incomplete: ${missing.join(", ")}`,
    );
  }
}

async function collectTestSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources: string[] = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) sources.push(...(await collectTestSources(path)));
    else if (entry.name.endsWith(".test.ts")) sources.push(path);
  }
  return sources;
}

export function parsePostgresPort(args: readonly string[]): number | undefined {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 0) return undefined;
  if (normalized.length !== 2 || normalized[0] !== "--port") {
    throw new PostgresDevelopmentError("Expected optional --port <number>");
  }
  const port = Number(normalized[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new PostgresDevelopmentError(
      "PostgreSQL port must be an integer from 1 to 65535",
    );
  }
  return port;
}

function spawnInteractive(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: environment,
      stdio: "inherit",
    });
    const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
    const interrupt = () => forwardSignal("SIGINT");
    const terminate = () => forwardSignal("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.on("error", () => {
      removeHandlers();
      reject(
        new PostgresDevelopmentError("Child process could not be started"),
      );
    });
    child.on("close", (code) => {
      removeHandlers();
      resolve(code ?? 1);
    });
    function removeHandlers() {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  });
}

if (process.argv[1] !== undefined) {
  const entrypointUrl = pathToFileURL(resolve(process.argv[1])).href;
  if (import.meta.url === entrypointUrl) {
    try {
      process.exitCode = await runPostgresCli();
    } catch (error) {
      writePreparationFailure(error);
      process.exitCode = 1;
    }
  }
}

function writePreparationFailure(error: unknown): void {
  if (error instanceof ConfigError) {
    process.stderr.write(
      `Configuration preparation failed [${error.code}]: ${error.message}\n`,
    );
    for (const issue of error.validationIssues ?? []) {
      process.stderr.write(
        `- ${issue.path} [${issue.code}]: ${issue.message}${issue.hint === undefined ? "" : ` Hint: ${issue.hint}`}\n`,
      );
    }
    return;
  }
  if (error instanceof ServerRuntimeConfigurationError) {
    process.stderr.write(
      `Configuration preparation failed [${error.code}]: ${error.message}\n`,
    );
    return;
  }
  if (error instanceof PostgresDevelopmentError) {
    process.stderr.write(
      `Database preparation failed [${error.name}]: ${error.message}\n`,
    );
    return;
  }
  process.stderr.write(
    "Development preparation failed [UnknownError]. Check configuration files and required local services.\n",
  );
}
