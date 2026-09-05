/**
 * 功能概述：本文件是 Kaguya 服务端唯一 composition root，负责读取配置、
 * 连接 PostgreSQL information database、组装 Runtime、HTTP/Web UI 与 NapCat，并把启动时
 * 选中的全局 Profile 冻结为一个共享 tier-only 模型解析器。
 * 主要职责：`startKaguyaServer` 会先在统一的启动保护区内创建异步
 * `ConfigurationManagement`，让缺失仓库先完成 bootstrap/open，再根据 selected
 * Profile readiness 决定当前进程是正常启动 Runtime，还是进入 setup-mode 暂停
 * Runtime/database/NapCat 仅提供配置入口；就绪时 Server 自行连接数据库并以
 * 注入形式构造 Runtime，Web/NapCat 只获得该 Runtime 的 `InformationIngress`。即使 bootstrap/open 阶段遇到
 * `CONFIG_UNSUPPORTED_VERSION` 或 `CONFIG_CORRUPT_STORE`，也必须沿用已有的
 * startup failed 日志与 logger 关闭路径。`createRuntimeModelSelectionResolver`
 * 只接收 `setup.inspect()` 已选中的 Profile 快照并校验，不再次读取 Registry；`openAICompatibleProviderSettings`
 * 提取 provider 能力开关；`assertProfileReady` 保持 readiness 错误固定且无 secret；
 * `connectInformationDatabase` 与 `startInformationRuntime` 将 lazy Pool 创建及
 * 首次 migrate/I/O 失败收窄为 database error，其他 Runtime/模块启动失败收窄为
 * 独立 runtime startup error；两类错误都不包含 URL、cause 或凭据；
 * 其余 helper 管理资源关闭与进程信号处理。
 * 代码库关系：本文件消费 `@kaguya/config` 的 Profile Registry、`@kaguya/runtime`
 * 的运行时注入点、Fastify HTTP 组装和 NapCat 适配器；模块层 `packages/modules`
 * 已不再携带模块级 Profile 标识，因此 Profile 选择只能在这里于服务启动时完成一次。
 * 输入输出与副作用：启动时会创建 logger、检查配置 readiness、按需连接数据库并启动 Runtime/HTTP/NapCat；
 * resolver 会缓存已选 Profile 下 provider client，并在 light/heavy tier 缺失时于启动期失败，
 * 防止服务接受请求后再暴露可变 Profile 覆盖路径；关闭时 Runtime 先排空，
 * 再由 Server 关闭它所有的数据库连接。
 */
import { pathToFileURL } from "node:url";
import { readdir } from "node:fs/promises";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  ConfigIncompleteError,
  ConfigReviewRequiredError,
  inspectUserConfigProfile,
  type UserConfigProfile,
} from "@kaguya/config";
import { KaguyaDatabase } from "@kaguya/database";
import {
  closeLogger,
  createLogger,
  createModuleLogger,
  readLoggerOptions,
  type KaguyaLogger,
} from "@kaguya/logger";
import {
  GatewayAllowlist,
  KaguyaRuntime,
  RuntimeDatabaseInitializationError,
  type RuntimeModelSelectionResolver,
} from "@kaguya/runtime";
import type { FastifyInstance } from "fastify";

import { createHttpApplication } from "./app.js";
import { readServerConfig, type ServerConfig } from "./config.js";
import {
  createBootstrapGatewayAuthenticator,
  createEnvironmentGatewayAuthenticator,
  createPersistentGatewayAuthenticator,
  type GatewayAuthenticator,
} from "./gateway-auth.js";
import { loadPersistentGatewayCredential } from "./gateway-credentials.js";
import {
  createNapCatSupervisor,
  type NapCatConnectionSupervisor,
} from "./napcat.js";
import { createConfigurationManagement } from "./setup.js";
import {
  defaultNapCatSettings,
  hasNapCatSettings,
  loadNapCatSettings,
  toNapCatConfig,
} from "./napcat-config.js";
import { createWebMessageGateway } from "./web-gateway.js";
import { registerWebUi, type WebUiHandle } from "./web.js";

export interface StartedKaguyaServer {
  readonly app: FastifyInstance;
  readonly runtime?: KaguyaRuntime;
  close(): Promise<void>;
}

export async function startKaguyaServer(
  providedConfig?: ServerConfig,
): Promise<StartedKaguyaServer> {
  const resolved =
    providedConfig === undefined
      ? readServerConfig()
      : {
          config: providedConfig,
          gatewayTokenSource: "environment" as const,
        };
  const config = resolved.config;
  const gatewayAuth = await resolveGatewayAuthenticator(
    config,
    resolved.gatewayTokenSource,
  );
  const rootLogger = createLogger(readLoggerOptions("kaguya"));
  const serverLogger = createModuleLogger(rootLogger, "server");
  const httpLogger = createModuleLogger(rootLogger, "server:http");
  const napcatLogger = createModuleLogger(rootLogger, "adapter:napcat");
  const webLogger = createModuleLogger(rootLogger, "adapter:web");
  let app: FastifyInstance | undefined;
  let webUi: WebUiHandle | undefined;
  let napcat: NapCatConnectionSupervisor | undefined;
  let closePromise: Promise<void> | undefined;
  let runtime: KaguyaRuntime | undefined;
  let database: KaguyaDatabase | undefined;

  const close = (): Promise<void> => {
    closePromise ??= closeResources({
      app,
      webUi,
      napcat,
      runtime,
      database,
      rootLogger,
      serverLogger,
    });
    return closePromise;
  };

  try {
    const setup = await createConfigurationManagement(config.configRoot);
    const hasPersistedNapCat = await hasNapCatSettings(config.configRoot);
    const persistedNapCat = hasPersistedNapCat
      ? await loadNapCatSettings(config.configRoot)
      : defaultNapCatSettings;
    const effectiveConfig: ServerConfig = {
      ...config,
      napcat: hasPersistedNapCat
        ? toNapCatConfig(persistedNapCat)
        : config.napcat,
    };
    const setupStatus = await setup.inspect();
    let resolveModelSelection: RuntimeModelSelectionResolver | undefined;
    if (setupStatus.status === "ready") {
      const profile = await setup.getProfile(setupStatus.selectedProfileId);
      resolveModelSelection = createRuntimeModelSelectionResolver(profile);
    } else {
      serverLogger.warn(
        {
          event: "server.configuration.required",
          reason: setupStatus.status,
          setupUrl: `http://${config.host}:${config.port}/`,
        },
        "Configuration is not ready; open the Web UI to complete setup",
      );
    }
    const runtimeReady = resolveModelSelection !== undefined;
    if (resolveModelSelection !== undefined) {
      database = await connectInformationDatabase(effectiveConfig.databaseUrl);
      runtime = new KaguyaRuntime({
        database,
        logger: rootLogger,
        resolveModelSelection,
      });
    }
    const webGateway = runtimeReady
      ? createWebMessageGateway({
          adapterId: "web.ui.main",
          ingress: required(runtime, "runtime ingress"),
          logger: webLogger,
        })
      : undefined;

    serverLogger.info(
      {
        event: "server.starting",
        host: effectiveConfig.host,
        port: effectiveConfig.port,
        development: config.development,
        napcatEnabled: runtimeReady && effectiveConfig.napcat.enabled,
      },
      "Kaguya server starting",
    );
    if (runtimeReady && effectiveConfig.napcat.enabled) {
      const gatewayAllowlist = new GatewayAllowlist(
        effectiveConfig.gatewayAllowlist,
      );
      napcat = createNapCatSupervisor({
        config: effectiveConfig.napcat,
        ingress: required(runtime, "runtime ingress"),
        logger: napcatLogger,
        allowsInbound: (message) => gatewayAllowlist.allows(message),
      });
      required(runtime, "runtime").registerTransport({
        adapterId: effectiveConfig.napcat.adapterId,
        platform: "qq",
        transport: napcat,
      });
    }
    if (runtimeReady) {
      await startInformationRuntime(required(runtime, "runtime"));
    }
    app = await createHttpApplication({
      config: effectiveConfig,
      gatewayAuth,
      ...(webGateway !== undefined ? { webGateway } : {}),
      setup,
      logger: httpLogger,
    });
    webUi = await registerWebUi(app, effectiveConfig);
    await app.listen({
      host: effectiveConfig.host,
      port: effectiveConfig.port,
    });

    if (runtimeReady && effectiveConfig.napcat.enabled) {
      napcatLogger.info(
        {
          event: "napcat.connection.starting",
          adapterId: config.napcat.adapterId,
        },
        "NapCat connection starting",
      );
      await napcat?.start();
    }

    serverLogger.info(
      {
        event: "server.started",
        host: effectiveConfig.host,
        port: effectiveConfig.port,
        napcatEnabled: runtimeReady && effectiveConfig.napcat.enabled,
      },
      "Kaguya server started",
    );
  } catch (error) {
    serverLogger.fatal(
      { event: "server.start.failed", errorType: safeErrorType(error) },
      "Kaguya server startup failed",
    );
    await close();
    throw error;
  }

  const started: StartedKaguyaServer = {
    app,
    ...(runtime === undefined ? {} : { runtime }),
    close,
  };
  registerShutdownHandlers(started, serverLogger);
  return started;
}

async function resolveGatewayAuthenticator(
  config: ServerConfig,
  source: "environment" | "generated",
): Promise<GatewayAuthenticator> {
  if (source === "environment") {
    return createEnvironmentGatewayAuthenticator(config.gatewayToken);
  }

  const persisted = await loadPersistentGatewayCredential(config.configRoot);
  if (persisted !== null) {
    return createPersistentGatewayAuthenticator(config.configRoot);
  }
  if (!isLoopbackHost(config.host) || !(await isFreshConfigurationRoot(config.configRoot))) {
    throw new Error(
      "KAGUYA_GATEWAY_TOKEN is required for non-loopback or existing configuration roots without a persistent gateway credential",
    );
  }

  const authenticator = await createBootstrapGatewayAuthenticator(
    config.configRoot,
  );
  process.stdout.write(
    `Kaguya first-run setup URL: http://${config.host}:${config.port}/#bootstrapToken=${authenticator.bootstrapToken}\n`,
  );
  return authenticator;
}

async function isFreshConfigurationRoot(rootDir: string): Promise<boolean> {
  try {
    return (await readdir(rootDir)).length === 0;
  } catch (error) {
    if (isMissingFileError(error)) {
      return true;
    }
    throw error;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createRuntimeModelSelectionResolver(
  profile: UserConfigProfile,
): RuntimeModelSelectionResolver {
  assertProfileReady(profile);
  const selectedProfileId = profile.id;
  const providerCache = new Map<
    string,
    ReturnType<typeof createOpenAICompatible>
  >();

  const resolver: RuntimeModelSelectionResolver = (selection) => {
    const target = profile.ai.modelTiers?.[selection.modelTier];
    if (target === undefined) {
      throw new Error(
        `Model tier is unavailable in selected profile ${selectedProfileId}: ${selection.modelTier}`,
      );
    }
    const provider = profile.ai.providers.find(
      ({ id }) => id === target.providerId,
    );
    if (provider === undefined || !provider.enabled) {
      throw new Error(
        `Model tier provider is unavailable in selected profile ${selectedProfileId}`,
      );
    }
    if (provider.type !== "openai-compatible") {
      throw new Error(
        `Unsupported AI provider type in selected profile ${selectedProfileId}: ${provider.type}`,
      );
    }
    if (provider.apiKey === undefined || provider.baseUrl === undefined) {
      throw new Error(
        `AI provider credentials are incomplete in selected profile ${selectedProfileId}`,
      );
    }
    const cacheKey = provider.id;
    let client = providerCache.get(cacheKey);
    if (client === undefined) {
      client = createOpenAICompatible({
        name: `kaguya-${selectedProfileId}-${provider.id}`,
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl,
        ...openAICompatibleProviderSettings(provider.settings),
      });
      providerCache.set(cacheKey, client);
    }
    return { modelId: target.modelId, model: client.chatModel(target.modelId) };
  };

  // Fail before HTTP/adapters start if either default tier is not executable.
  resolver({ modelTier: "light" });
  resolver({ modelTier: "heavy" });
  return resolver;
}

export class InformationDatabaseConnectionError extends Error {
  readonly failureType: string;

  constructor(error: unknown) {
    super("Information database connection failed");
    this.name = "InformationDatabaseConnectionError";
    this.failureType = safeErrorType(error);
  }
}

export class InformationRuntimeStartupError extends Error {
  readonly failureType: string;

  constructor(error: unknown) {
    super("Information runtime startup failed");
    this.name = "InformationRuntimeStartupError";
    this.failureType = safeErrorType(error);
  }
}

async function connectInformationDatabase(
  databaseUrl: string,
): Promise<KaguyaDatabase> {
  try {
    return await KaguyaDatabase.connect({
      connectionString: databaseUrl,
    });
  } catch (error) {
    throw new InformationDatabaseConnectionError(error);
  }
}

async function startInformationRuntime(runtime: KaguyaRuntime): Promise<void> {
  try {
    await runtime.start();
  } catch (error) {
    if (isRuntimeDatabaseInitializationError(error)) {
      throw new InformationDatabaseConnectionError(error);
    }
    throw new InformationRuntimeStartupError(error);
  }
}

function openAICompatibleProviderSettings(
  settings: UserConfigProfile["ai"]["providers"][number]["settings"],
): { supportsStructuredOutputs?: boolean } {
  return typeof settings.supportsStructuredOutputs === "boolean"
    ? { supportsStructuredOutputs: settings.supportsStructuredOutputs }
    : {};
}

function assertProfileReady(profile: UserConfigProfile): void {
  const readiness = inspectUserConfigProfile(profile);
  if (readiness.status === "invalid") {
    throw new ConfigIncompleteError(readiness.issues);
  }
  if (readiness.status === "review_required") {
    throw new ConfigReviewRequiredError(readiness.warnings);
  }
}

async function closeResources(options: {
  readonly app: FastifyInstance | undefined;
  readonly webUi: WebUiHandle | undefined;
  readonly napcat: NapCatConnectionSupervisor | undefined;
  readonly runtime: KaguyaRuntime | undefined;
  readonly database: KaguyaDatabase | undefined;
  readonly rootLogger: KaguyaLogger;
  readonly serverLogger: KaguyaLogger;
}): Promise<void> {
  options.serverLogger.info(
    { event: "server.stopping" },
    "Kaguya server stopping",
  );
  const failures: unknown[] = [];
  const ingressResults = await Promise.allSettled([
    options.app?.close() ?? Promise.resolve(),
    options.napcat?.stop() ?? Promise.resolve(),
  ]);
  collectFailures(ingressResults, failures);

  if (options.runtime !== undefined) {
    try {
      await options.runtime.close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await options.database?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await options.webUi?.close();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 0) {
    options.serverLogger.info(
      { event: "server.stopped" },
      "Kaguya server stopped",
    );
  } else {
    options.serverLogger.fatal(
      {
        event: "server.shutdown.failed",
        failureCount: failures.length,
        errorType: safeErrorType(failures[0]),
      },
      "Kaguya server shutdown failed",
    );
  }
  await closeLogger(options.rootLogger);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Kaguya server shutdown failed");
  }
}

function safeErrorType(error: unknown): string {
  try {
    if (error instanceof AggregateError) return "AggregateError";
    if (error instanceof InformationDatabaseConnectionError) {
      return "InformationDatabaseConnectionError";
    }
    if (error instanceof InformationRuntimeStartupError) {
      return "InformationRuntimeStartupError";
    }
    return error instanceof Error ? "Error" : "UnknownError";
  } catch {
    return "UnknownError";
  }
}

function isRuntimeDatabaseInitializationError(
  error: unknown,
): error is RuntimeDatabaseInitializationError {
  try {
    return error instanceof RuntimeDatabaseInitializationError;
  } catch {
    return false;
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function collectFailures(
  results: readonly PromiseSettledResult<unknown>[],
  failures: unknown[],
): void {
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
}

function registerShutdownHandlers(
  server: StartedKaguyaServer,
  logger: KaguyaLogger,
): void {
  const shutdown = () => {
    void server.close().catch((error: unknown) => {
      process.exitCode = 1;
      if (!logger.isLevelEnabled("fatal")) {
        process.stderr.write(`Kaguya shutdown failed: ${String(error)}\n`);
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] !== undefined) {
  const entrypointUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entrypointUrl) {
    await startKaguyaServer().catch(() => {
      process.exitCode = 1;
    });
  }
}
