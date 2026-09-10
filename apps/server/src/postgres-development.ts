/**
 * 功能概述：为本地开发和真实 PostgreSQL 测试提供 PostgreSQL 17 生命周期编排。
 * 主要职责：通过 Docker CLI 创建/恢复固定容器和数据卷、等待 pg_isready、校验
 * 容器身份与端口，并用生产 Database/Runtime kind 路径执行连接、schema 准备和 kind 检查；
 * selected Profile 标记 external 时完全不调用 Docker。
 * 代码库关系：postgres-cli.ts 提供命令行入口；Server 自身不导入本模块，因此生产启动
 * 永远不会取得 Docker 权限。配置写入通过 @kaguya/config 的原子 Profile replacement。
 * 输入输出与副作用：start 会创建/启动容器并可能补齐缺失的 selected Profile runtime；
 * status 只读；start/check 初始化空 schema 或验证严格 v1，并同步 Kind。所有公开错误均不保留原始输出。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  FileUserConfigManager,
  runtimeConfigSchema,
  type RuntimeConfig,
  type UserConfigProfile,
} from "@kaguya/config";
import { KaguyaDatabase, SUPPORTED_POSTGRES_MAJOR } from "@kaguya/database";
import { runtimeInformationKindNames } from "@kaguya/runtime";

import { createReplyCatalog } from "./runtime-composition.js";

export const MANAGED_POSTGRES_IMAGE = "postgres:17-alpine";
export const MANAGED_POSTGRES_CONTAINER = "kaguya-postgres-17";
export const MANAGED_POSTGRES_VOLUME = "kaguya-postgres-17-data";
export const MANAGED_POSTGRES_LABEL = "dev.kaguya.postgres=17";
export const DEFAULT_MANAGED_POSTGRES_PORT = 5432;

const managedUser = "kaguya";
const managedPassword = "kaguya-local-dev";
const managedDatabase = "kaguya";
const containerDataDirectory = "/var/lib/postgresql/data";
const defaultWebDistPath = fileURLToPath(
  new URL("../../web/dist", import.meta.url),
);

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandResult>;

export interface ManagedPostgresStatus {
  readonly exists: boolean;
  readonly state: "external" | "missing" | "created" | "running" | "stopped";
  readonly healthy: boolean;
  readonly port?: number;
  readonly postgresMajor?: number;
}

export interface PostgresDevelopmentDependencies {
  readonly runCommand?: CommandRunner;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly checkDatabase?: (
    databaseUrl: string,
    options: { readonly prepareSchema: boolean },
  ) => Promise<void>;
}

export class PostgresDevelopmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresDevelopmentError";
  }
}

export async function ensureDevelopmentPostgres(options: {
  readonly configRoot: string;
  readonly port?: number;
  readonly dependencies?: PostgresDevelopmentDependencies;
}): Promise<{
  readonly databaseUrl: string;
  readonly mode: "managed" | "external";
}> {
  const profileState = await openSelectedProfile(options.configRoot);
  const runtime = profileState?.profile.runtime;
  if (runtime?.databaseMode === "external") {
    await checkDatabase(
      runtime.databaseUrl,
      { prepareSchema: true },
      options.dependencies,
    );
    return { databaseUrl: runtime.databaseUrl, mode: "external" };
  }

  const configuredPort =
    runtime === undefined
      ? options.port
      : managedPortFromRuntime(runtime, options.port);
  const managed = await ensureManagedPostgres({
    ...(configuredPort === undefined ? {} : { port: configuredPort }),
    ...(options.dependencies === undefined
      ? {}
      : { dependencies: options.dependencies }),
  });
  await checkManagedPostgresDatabase(
    managed.databaseUrl,
    { prepareSchema: true },
    options.dependencies,
  );

  if (runtime === undefined) {
    const selected =
      profileState ?? (await bootstrapSelectedProfile(options.configRoot));
    await replaceProfileRuntime(
      selected.manager,
      selected.profile,
      defaultDevelopmentRuntime(managed.databaseUrl),
    );
  }
  return { databaseUrl: managed.databaseUrl, mode: "managed" };
}

export async function ensureManagedPostgres(options: {
  readonly port?: number;
  readonly dependencies?: PostgresDevelopmentDependencies;
}): Promise<{ readonly databaseUrl: string; readonly port: number }> {
  const dependencies = dependenciesWithDefaults(options.dependencies);
  await assertDockerAvailable(dependencies.runCommand);
  let inspection = await inspectManagedContainer(dependencies.runCommand);
  const requestedPort = validatedPort(
    options.port ?? inspection?.port ?? DEFAULT_MANAGED_POSTGRES_PORT,
  );
  if (inspection === undefined) {
    await createManagedContainer(dependencies.runCommand, requestedPort);
    inspection = await inspectManagedContainer(dependencies.runCommand);
    if (inspection === undefined) {
      throw new PostgresDevelopmentError(
        "Managed PostgreSQL container creation did not complete",
      );
    }
  }
  assertManagedContainerIdentity(inspection, requestedPort);
  if (inspection.state !== "running") {
    await requiredDockerCommand(
      dependencies.runCommand,
      ["container", "start", MANAGED_POSTGRES_CONTAINER],
      "Managed PostgreSQL container could not be started",
    );
  }
  await waitForPgIsReady(dependencies);
  return {
    port: requestedPort,
    databaseUrl: managedConnectionUrl(requestedPort),
  };
}

export async function readDevelopmentPostgresStatus(options: {
  readonly configRoot: string;
  readonly dependencies?: PostgresDevelopmentDependencies;
}): Promise<{
  readonly mode: "managed" | "external" | "unconfigured";
  readonly status: ManagedPostgresStatus;
}> {
  const profileState = await openSelectedProfile(options.configRoot);
  if (profileState?.profile.runtime?.databaseMode === "external") {
    let healthy = true;
    const port = databasePort(profileState.profile.runtime.databaseUrl);
    try {
      await checkDatabase(
        profileState.profile.runtime.databaseUrl,
        { prepareSchema: false },
        options.dependencies,
      );
    } catch {
      healthy = false;
    }
    return {
      mode: "external",
      status: {
        exists: false,
        state: "external",
        healthy,
        ...(port === undefined ? {} : { port }),
        ...(healthy ? { postgresMajor: SUPPORTED_POSTGRES_MAJOR } : {}),
      },
    };
  }

  const dependencies = dependenciesWithDefaults(options.dependencies);
  await assertDockerAvailable(dependencies.runCommand);
  const inspection = await inspectManagedContainer(dependencies.runCommand);
  if (inspection === undefined) {
    return {
      mode:
        profileState?.profile.runtime === undefined
          ? "unconfigured"
          : "managed",
      status: { exists: false, state: "missing", healthy: false },
    };
  }
  let healthy = false;
  if (inspection.state === "running") {
    healthy =
      (await dependencies.runCommand("docker", pgIsReadyArguments()))
        .exitCode === 0;
    if (healthy) {
      try {
        await checkDatabase(
          managedConnectionUrl(inspection.port),
          { prepareSchema: false },
          options.dependencies,
        );
      } catch {
        healthy = false;
      }
    }
  }
  return {
    mode:
      profileState?.profile.runtime === undefined ? "unconfigured" : "managed",
    status: {
      exists: true,
      state: inspection.state,
      healthy,
      port: inspection.port,
      ...(healthy ? { postgresMajor: SUPPORTED_POSTGRES_MAJOR } : {}),
    },
  };
}

export async function checkDevelopmentPostgres(options: {
  readonly configRoot: string;
  readonly dependencies?: PostgresDevelopmentDependencies;
}): Promise<{
  readonly mode: "managed" | "external";
  readonly databaseUrl: string;
}> {
  const profileState = await openSelectedProfile(options.configRoot);
  const runtime = profileState?.profile.runtime;
  if (runtime === undefined) {
    throw new PostgresDevelopmentError(
      "Selected Profile runtime is not configured; run postgres:start",
    );
  }
  if (runtime.databaseMode === "external") {
    await checkDatabase(
      runtime.databaseUrl,
      { prepareSchema: true },
      options.dependencies,
    );
    return { mode: "external", databaseUrl: runtime.databaseUrl };
  }
  const dependencies = dependenciesWithDefaults(options.dependencies);
  await assertDockerAvailable(dependencies.runCommand);
  const inspection = await inspectManagedContainer(dependencies.runCommand);
  if (inspection === undefined || inspection.state !== "running") {
    throw new PostgresDevelopmentError(
      "Managed PostgreSQL container is not running; run postgres:start",
    );
  }
  const port = managedPortFromRuntime(runtime);
  assertManagedContainerIdentity(inspection, port);
  const ready = await dependencies.runCommand("docker", pgIsReadyArguments());
  if (ready.exitCode !== 0) {
    throw new PostgresDevelopmentError("Managed PostgreSQL is not ready");
  }
  await checkDatabase(
    runtime.databaseUrl,
    { prepareSchema: true },
    options.dependencies,
  );
  return { mode: "managed", databaseUrl: runtime.databaseUrl };
}

export async function checkPostgresTestDatabase(
  databaseUrl: string,
  dependencies?: PostgresDevelopmentDependencies,
): Promise<void> {
  await checkDatabase(databaseUrl, { prepareSchema: false }, dependencies);
}

export async function checkManagedPostgresDatabase(
  databaseUrl: string,
  options: { readonly prepareSchema: boolean },
  supplied?: PostgresDevelopmentDependencies,
): Promise<void> {
  const dependencies = dependenciesWithDefaults(supplied);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await dependencies.checkDatabase(databaseUrl, options);
      return;
    } catch {
      if (attempt === 19) {
        throw new PostgresDevelopmentError("PostgreSQL readiness check failed");
      }
      await dependencies.wait(250);
    }
  }
}

export function managedConnectionUrl(port: number): string {
  return `postgresql://${managedUser}:${managedPassword}@127.0.0.1:${validatedPort(port)}/${managedDatabase}`;
}

export function defaultDevelopmentRuntime(databaseUrl: string): RuntimeConfig {
  return runtimeConfigSchema.parse({
    host: "127.0.0.1",
    port: 3000,
    databaseMode: "managed",
    databaseUrl,
    webDistPath: defaultWebDistPath,
    corsOrigins: [],
    trustProxy: false,
    rateLimitMax: 30,
    rateLimitWindowMs: 60_000,
    logLevel: "info",
    logFormat: "pretty",
    gatewayAllowlist: [],
  });
}

export const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      reject(
        new PostgresDevelopmentError("Required command could not be executed"),
      );
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout: stdout.trim() });
    });
  });

interface ContainerInspection {
  readonly image: string;
  readonly label: string;
  readonly state: "created" | "running" | "stopped";
  readonly hostIp: string;
  readonly port: number;
  readonly volume: string;
}

async function openSelectedProfile(configRoot: string): Promise<
  | {
      readonly manager: FileUserConfigManager;
      readonly profile: UserConfigProfile;
    }
  | undefined
> {
  const readiness = await FileUserConfigManager.inspect({
    rootDir: configRoot,
  });
  if (readiness.status === "setup_required") return undefined;
  const manager = await FileUserConfigManager.open({ rootDir: configRoot });
  const profile = await manager.getProfile(manager.getSelectedProfileId());
  return { manager, profile };
}

async function bootstrapSelectedProfile(configRoot: string) {
  const manager = await FileUserConfigManager.bootstrap({
    rootDir: configRoot,
  });
  const profile = await manager.getProfile(manager.getSelectedProfileId());
  return { manager, profile };
}

async function replaceProfileRuntime(
  manager: FileUserConfigManager,
  profile: UserConfigProfile,
  runtime: RuntimeConfig,
): Promise<void> {
  await manager.replaceProfile(profile.id, {
    name: profile.name,
    acknowledgedWarnings: profile.review?.acknowledgedWarnings ?? [],
    identity: profile.identity,
    ai: profile.ai,
    memory: profile.memory,
    platforms: profile.platforms,
    runtime,
  });
}

function managedPortFromRuntime(
  runtime: RuntimeConfig,
  requestedPort?: number,
): number {
  let url: URL;
  try {
    url = new URL(runtime.databaseUrl);
  } catch {
    throw new PostgresDevelopmentError(
      "Managed PostgreSQL Profile URL is invalid",
    );
  }
  const port = validatedPort(
    Number.parseInt(url.port || String(DEFAULT_MANAGED_POSTGRES_PORT), 10),
  );
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== managedUser ||
    url.password !== managedPassword ||
    url.pathname !== `/${managedDatabase}`
  ) {
    throw new PostgresDevelopmentError(
      "Managed PostgreSQL Profile does not match the first-party instance",
    );
  }
  if (requestedPort !== undefined && validatedPort(requestedPort) !== port) {
    throw new PostgresDevelopmentError(
      "Managed PostgreSQL port cannot change after Profile initialization",
    );
  }
  return port;
}

async function assertDockerAvailable(runner: CommandRunner): Promise<void> {
  const result = await runner("docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]).catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) {
    throw new PostgresDevelopmentError(
      "Docker-compatible engine is unavailable; start Docker Desktop or OrbStack",
    );
  }
}

async function inspectManagedContainer(
  runner: CommandRunner,
): Promise<ContainerInspection | undefined> {
  const format = [
    "{{.Config.Image}}",
    '{{index .Config.Labels "dev.kaguya.postgres"}}',
    "{{.State.Status}}",
    '{{with index .HostConfig.PortBindings "5432/tcp"}}{{(index . 0).HostIp}}{{end}}',
    '{{with index .HostConfig.PortBindings "5432/tcp"}}{{(index . 0).HostPort}}{{end}}',
    `{{range .Mounts}}{{if eq .Destination "${containerDataDirectory}"}}{{.Name}}{{end}}{{end}}`,
  ].join("\t");
  const result = await runner("docker", [
    "container",
    "inspect",
    MANAGED_POSTGRES_CONTAINER,
    "--format",
    format,
  ]);
  if (result.exitCode !== 0) return undefined;
  const [image, label, rawState, hostIp, rawPort, volume] =
    result.stdout.split("\t");
  const state =
    rawState === "running"
      ? "running"
      : rawState === "created"
        ? "created"
        : "stopped";
  return {
    image: image ?? "",
    label: label ?? "",
    state,
    hostIp: hostIp ?? "",
    port: Number.parseInt(rawPort ?? "", 10),
    volume: volume ?? "",
  };
}

function assertManagedContainerIdentity(
  inspection: ContainerInspection,
  expectedPort: number,
): void {
  if (
    inspection.image !== MANAGED_POSTGRES_IMAGE ||
    inspection.label !== "17" ||
    inspection.hostIp !== "127.0.0.1" ||
    inspection.port !== expectedPort ||
    inspection.volume !== MANAGED_POSTGRES_VOLUME
  ) {
    throw new PostgresDevelopmentError(
      "Existing managed PostgreSQL container configuration does not match",
    );
  }
}

async function createManagedContainer(
  runner: CommandRunner,
  port: number,
): Promise<void> {
  await requiredDockerCommand(
    runner,
    [
      "volume",
      "create",
      "--label",
      MANAGED_POSTGRES_LABEL,
      MANAGED_POSTGRES_VOLUME,
    ],
    "Managed PostgreSQL data volume could not be created",
  );
  await requiredDockerCommand(
    runner,
    [
      "container",
      "create",
      "--name",
      MANAGED_POSTGRES_CONTAINER,
      "--label",
      MANAGED_POSTGRES_LABEL,
      "--publish",
      `127.0.0.1:${port}:5432`,
      "--mount",
      `type=volume,source=${MANAGED_POSTGRES_VOLUME},target=${containerDataDirectory}`,
      "--env",
      `POSTGRES_USER=${managedUser}`,
      "--env",
      `POSTGRES_PASSWORD=${managedPassword}`,
      "--env",
      `POSTGRES_DB=${managedDatabase}`,
      "--health-cmd",
      `pg_isready -U ${managedUser} -d ${managedDatabase}`,
      "--health-interval",
      "2s",
      "--health-timeout",
      "5s",
      "--health-retries",
      "30",
      MANAGED_POSTGRES_IMAGE,
    ],
    "Managed PostgreSQL container could not be created",
  );
}

async function requiredDockerCommand(
  runner: CommandRunner,
  args: readonly string[],
  failureMessage: string,
): Promise<void> {
  const result = await runner("docker", args).catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) {
    throw new PostgresDevelopmentError(failureMessage);
  }
}

async function waitForPgIsReady(
  dependencies: Required<PostgresDevelopmentDependencies>,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await dependencies.runCommand(
      "docker",
      pgIsReadyArguments(),
    );
    if (result.exitCode === 0) return;
    await dependencies.wait(500);
  }
  throw new PostgresDevelopmentError(
    "Managed PostgreSQL did not become ready within 60 seconds",
  );
}

function pgIsReadyArguments(): readonly string[] {
  return [
    "container",
    "exec",
    MANAGED_POSTGRES_CONTAINER,
    "pg_isready",
    "-U",
    managedUser,
    "-d",
    managedDatabase,
  ];
}

async function checkDatabase(
  databaseUrl: string,
  options: { readonly prepareSchema: boolean },
  supplied?: PostgresDevelopmentDependencies,
): Promise<void> {
  const custom = supplied?.checkDatabase;
  if (custom !== undefined) return custom(databaseUrl, options);
  let database: KaguyaDatabase | undefined;
  try {
    database = await KaguyaDatabase.connect({ connectionString: databaseUrl });
    if (options.prepareSchema) {
      await database.prepareSchema();
      await database.information.synchronizeKinds(
        runtimeInformationKindNames(createReplyCatalog()),
      );
    }
  } catch {
    throw new PostgresDevelopmentError("PostgreSQL readiness check failed");
  } finally {
    try {
      await database?.close();
    } catch {
      // A readiness result must never expose close errors or connection data.
    }
  }
}

function dependenciesWithDefaults(
  dependencies: PostgresDevelopmentDependencies = {},
): Required<PostgresDevelopmentDependencies> {
  return {
    runCommand: dependencies.runCommand ?? runCommand,
    wait:
      dependencies.wait ??
      ((milliseconds) =>
        new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))),
    checkDatabase:
      dependencies.checkDatabase ??
      ((databaseUrl, options) => checkDatabase(databaseUrl, options)),
  };
}

function validatedPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new PostgresDevelopmentError(
      "Managed PostgreSQL port must be an integer from 1 to 65535",
    );
  }
  return port;
}

function databasePort(databaseUrl: string): number | undefined {
  try {
    const url = new URL(databaseUrl);
    return validatedPort(
      Number.parseInt(url.port || String(DEFAULT_MANAGED_POSTGRES_PORT), 10),
    );
  } catch {
    return undefined;
  }
}
