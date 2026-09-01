/**
 * 功能概述：本文件是 Kaguya 服务端主入口，负责读取 ServerConfig、组装 HTTP 应用、
 * Web UI、NapCat 连接与 Runtime，并把配置 Registry 中当前选中的 Profile 冻结成
 * 一个供 Runtime 使用的 tier-only 模型解析器。
 * 主要职责：`startKaguyaServer` 会先在统一的启动保护区内创建异步
 * `ConfigurationManagement`，让缺失仓库先完成 bootstrap/open，再根据 selected
 * Profile readiness 决定当前进程是正常启动 Runtime，还是进入 setup-mode 暂停
 * Runtime/NapCat 仅提供配置入口；即使 bootstrap/open 阶段遇到
 * `CONFIG_UNSUPPORTED_VERSION` 或 `CONFIG_CORRUPT_STORE`，也必须沿用已有的
 * startup failed 日志与 logger 关闭路径。`createRuntimeModelSelectionResolver`
 * 继续在启动时读取当前 selected Profile 并校验；`openAICompatibleProviderSettings`
 * 提取 provider 能力开关；`assertProfileReady` 保持 readiness 错误固定且无 secret；
 * 其余 helper 管理资源关闭与进程信号处理。
 * 代码库关系：本文件消费 `@kaguya/config` 的 Profile Registry、`@kaguya/runtime`
 * 的运行时注入点、Fastify HTTP 组装和 NapCat 适配器；模块层 `packages/modules`
 * 已不再携带 `profileId`，因此 Profile 选择只能在这里于服务启动时完成一次。
 * 输入输出与副作用：启动时会创建 logger、检查配置 readiness、按需启动 Runtime/HTTP/NapCat；
 * resolver 会缓存已选 Profile 下 provider client，并在 light/heavy tier 缺失时于启动期失败，
 * 防止服务接受请求后再暴露可变 Profile 覆盖路径。
 */
import { pathToFileURL } from "node:url";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  ConfigSetupRequiredError,
  ConfigIncompleteError,
  ConfigReviewRequiredError,
  FileUserConfigManager,
  inspectUserConfigProfile,
  type UserConfigProfile,
} from "@kaguya/config";
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
  type RuntimeModelSelectionResolver,
} from "@kaguya/runtime";
import type { FastifyInstance } from "fastify";

import { createHttpApplication } from "./app.js";
import { readServerConfig, type ServerConfig } from "./config.js";
import {
  createNapCatSupervisor,
  type NapCatConnectionSupervisor,
} from "./napcat.js";
import { createConfigurationManagement } from "./setup.js";
import { registerWebUi, type WebUiHandle } from "./web.js";

export interface StartedKaguyaServer {
  readonly app: FastifyInstance;
  readonly runtime: KaguyaRuntime;
  close(): Promise<void>;
}

export async function startKaguyaServer(
  config: ServerConfig = readServerConfig(),
): Promise<StartedKaguyaServer> {
  const rootLogger = createLogger(readLoggerOptions("kaguya"));
  const serverLogger = createModuleLogger(rootLogger, "server");
  const httpLogger = createModuleLogger(rootLogger, "server:http");
  const napcatLogger = createModuleLogger(rootLogger, "adapter:napcat");
  let app: FastifyInstance | undefined;
  let webUi: WebUiHandle | undefined;
  let napcat: NapCatConnectionSupervisor | undefined;
  let closePromise: Promise<void> | undefined;
  let runtime: KaguyaRuntime | undefined;

  const close = (): Promise<void> => {
    closePromise ??= closeResources({
      app,
      webUi,
      napcat,
      runtime,
      rootLogger,
      serverLogger,
    });
    return closePromise;
  };

  try {
    const setup = await createConfigurationManagement(config.configRoot);
    const setupStatus = await setup.inspect();
    let resolveModelSelection: RuntimeModelSelectionResolver | undefined;
    if (setupStatus.status === "ready") {
      try {
        resolveModelSelection = await createRuntimeModelSelectionResolver(
          config.configRoot,
        );
      } catch (error) {
        if (!isRecoverableConfigurationError(error)) {
          throw error;
        }
        serverLogger.warn(
          {
            event: "server.configuration.required",
            reason: error.code,
            setupUrl: `http://${config.host}:${config.port}/`,
          },
          "Configuration is not ready; open the Web UI to complete setup",
        );
      }
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
    runtime = new KaguyaRuntime({
      databasePath: config.databasePath,
      logger: rootLogger,
      ...(resolveModelSelection === undefined ? {} : { resolveModelSelection }),
      gatewayAllowlist: new GatewayAllowlist(config.gatewayAllowlist),
    });
    const runtimeReady = resolveModelSelection !== undefined;

    serverLogger.info(
      {
        event: "server.starting",
        host: config.host,
        port: config.port,
        development: config.development,
        napcatEnabled: runtimeReady && config.napcat.enabled,
      },
      "Kaguya server starting",
    );
    if (runtimeReady && config.napcat.enabled) {
      napcat = createNapCatSupervisor({
        config: config.napcat,
        runtime,
        logger: napcatLogger,
      });
      runtime.registerTransport({
        adapterId: config.napcat.adapterId,
        platform: "qq",
        transport: napcat,
      });
    }
    if (runtimeReady) {
      await runtime.start();
    }
    app = await createHttpApplication({
      config,
      ...(runtimeReady ? { messageIngress: runtime } : {}),
      setup,
      logger: httpLogger,
    });
    webUi = await registerWebUi(app, config);
    await app.listen({ host: config.host, port: config.port });

    if (runtimeReady && config.napcat.enabled) {
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
        host: config.host,
        port: config.port,
        napcatEnabled: runtimeReady && config.napcat.enabled,
      },
      "Kaguya server started",
    );
  } catch (error) {
    serverLogger.fatal(
      { event: "server.start.failed", err: error },
      "Kaguya server startup failed",
    );
    await close();
    throw error;
  }

  const started: StartedKaguyaServer = {
    app,
    runtime,
    close,
  };
  registerShutdownHandlers(started, serverLogger);
  return started;
}

function isRecoverableConfigurationError(
  error: unknown,
): error is
  ConfigSetupRequiredError | ConfigIncompleteError | ConfigReviewRequiredError {
  return (
    error instanceof ConfigSetupRequiredError ||
    error instanceof ConfigIncompleteError ||
    error instanceof ConfigReviewRequiredError
  );
}

export async function createRuntimeModelSelectionResolver(
  configRoot: string,
): Promise<RuntimeModelSelectionResolver> {
  const manager = await FileUserConfigManager.open({ rootDir: configRoot });
  const selectedProfileId = manager.getSelectedProfileId();
  const profile = await manager.resolveProfileById(selectedProfileId);
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
        err: failures[0],
      },
      "Kaguya server shutdown failed",
    );
  }
  await closeLogger(options.rootLogger);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Kaguya server shutdown failed");
  }
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
