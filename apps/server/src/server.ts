/**
 * 功能概述：本文件是 Kaguya 服务端主入口，负责读取 ServerConfig、组装 HTTP 应用、
 * Web UI、NapCat 连接与 Runtime，并把配置 Registry 中当前选中的 Profile 冻结成
 * 一个供 Runtime 使用的 tier-only 模型解析器。
 * 主要职责：`startKaguyaServer` 在创建 HTTP、Runtime 或平台 ingress 之前调用
 * `validateStartupConfiguration`，把 selected Profile 冻结为可执行的 ServerConfig；
 * 校验失败时记录脱敏 issue、输出终端指引并沿用统一 logger 关闭路径。随后
 * `createRuntimeModelSelectionResolver` 从同一 Profile 创建 tier-only 模型解析器；
 * 其余 helper 管理资源关闭与进程信号处理。
 * 代码库关系：本文件消费 `@kaguya/config` 的 Profile Registry、`@kaguya/runtime`
 * 的运行时注入点、Fastify HTTP 组装和 NapCat 适配器；模块层 `packages/modules`
 * 已不再携带 `profileId`，因此 Profile 选择只能在这里于服务启动时完成一次。
 * 输入输出与副作用：启动时会创建 bootstrap logger、执行配置校验并在成功后启动 Runtime/HTTP/NapCat；
 * resolver 会缓存已选 Profile 下 provider client，并在 light/heavy tier 缺失时于启动期失败，
 * 防止服务接受请求后再暴露可变 Profile 覆盖路径。
 */
import { pathToFileURL } from "node:url";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  FileUserConfigManager,
  StartupConfigurationError,
  validateStartupConfiguration,
  type UserConfigProfile,
  type ValidatedStartupConfiguration,
} from "@kaguya/config";
import {
  closeLogger,
  createLogger,
  createModuleLogger,
  type KaguyaLogger,
} from "@kaguya/logger";
import {
  GatewayAllowlist,
  KaguyaRuntime,
  type RuntimeModelSelectionResolver,
} from "@kaguya/runtime";
import type { FastifyInstance } from "fastify";

import { createHttpApplication } from "./app.js";
import { readConfigRoot, type ServerConfig } from "./config.js";
import {
  createNapCatSupervisor,
  type NapCatConnectionSupervisor,
} from "./napcat.js";
import { createConfigurationManagement } from "./setup.js";
import { createWebMessageGateway } from "./web-gateway.js";
import { registerWebUi, type WebUiHandle } from "./web.js";

function serverConfigFromValidated(
  validated: ValidatedStartupConfiguration,
): ServerConfig {
  const napcat = validated.profile.platforms.find(
    (platform) => platform.enabled && platform.type === "napcat",
  );
  const napcatSettings = napcat?.settings ?? {};
  const napcatCredentials = napcat?.credentials ?? {};
  const adapterId = stringSetting(napcatSettings.adapterId);
  const wsUrl = stringSetting(napcatSettings.wsUrl);
  const selfId = stringSetting(napcatSettings.selfId);
  const accessToken = stringSetting(napcatCredentials.accessToken);
  const reconnectMs = numberSetting(napcatSettings.reconnectMs);
  return {
    ...validated.runtime,
    configRoot: validated.configRoot,
    development: false,
    napcat: {
      enabled: napcat !== undefined,
      adapterId: adapterId ?? "napcat.qq.main",
      ...(wsUrl === undefined ? {} : { wsUrl }),
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(selfId === undefined ? {} : { selfId }),
      reconnectMs: reconnectMs ?? 3000,
    },
  };
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function writeConfigurationFailure(error: StartupConfigurationError): void {
  const lines = [
    "Kaguya 启动配置校验失败。",
    `配置目录：${error.configRoot}`,
    ...error.issues.map(
      (issue) => `- [${issue.code}] ${issue.path}: ${issue.message}`,
    ),
    "请修正 selected Profile 后重新启动服务。",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

export interface StartedKaguyaServer {
  readonly app: FastifyInstance;
  readonly runtime: KaguyaRuntime;
  close(): Promise<void>;
}

export async function startKaguyaServer(
  providedConfig?: ServerConfig,
): Promise<StartedKaguyaServer> {
  let config = providedConfig;
  let rootLogger = createLogger({ service: "kaguya", level: "info" });
  let serverLogger = createModuleLogger(rootLogger, "server");
  let httpLogger = createModuleLogger(rootLogger, "server:http");
  let napcatLogger = createModuleLogger(rootLogger, "adapter:napcat");
  let webLogger = createModuleLogger(rootLogger, "adapter:web");
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
    const configRoot = config?.configRoot ?? readConfigRoot();
    serverLogger.info(
      { event: "configuration.validation.started", configRoot },
      "Validating startup configuration",
    );
    const validated = await validateStartupConfiguration({ rootDir: configRoot });
    config = serverConfigFromValidated(validated);
    await closeLogger(rootLogger);
    rootLogger = createLogger({
      service: "kaguya",
      level: validated.runtime.logLevel,
      format: validated.runtime.logFormat,
    });
    serverLogger = createModuleLogger(rootLogger, "server");
    httpLogger = createModuleLogger(rootLogger, "server:http");
    napcatLogger = createModuleLogger(rootLogger, "adapter:napcat");
    webLogger = createModuleLogger(rootLogger, "adapter:web");
    serverLogger.info(
      {
        event: "configuration.validation.succeeded",
        configRoot,
        profileId: validated.selectedProfileId,
        platformCount: validated.profile.platforms.filter(
          ({ enabled, type }) => enabled && type !== "web",
        ).length,
      },
      "Startup configuration validated",
    );
    const resolvedConfig = config;
    const setup = await createConfigurationManagement(resolvedConfig.configRoot);
    const resolveModelSelection = await createRuntimeModelSelectionResolver(
      resolvedConfig.configRoot,
    );
    runtime = new KaguyaRuntime({
      databasePath: resolvedConfig.databasePath,
      logger: rootLogger,
      resolveModelSelection,
      gatewayAllowlist: new GatewayAllowlist(resolvedConfig.gatewayAllowlist),
    });
    const webGateway = createWebMessageGateway({
      adapterId: "web.ui.main",
      runtime,
      logger: webLogger,
    });

    serverLogger.info(
      {
        event: "server.starting",
        host: resolvedConfig.host,
        port: resolvedConfig.port,
        development: resolvedConfig.development,
        napcatEnabled: resolvedConfig.napcat.enabled,
      },
      "Kaguya server starting",
    );
    if (resolvedConfig.napcat.enabled) {
      napcat = createNapCatSupervisor({
        config: resolvedConfig.napcat,
        runtime,
        logger: napcatLogger,
      });
      runtime.registerTransport({
        adapterId: resolvedConfig.napcat.adapterId,
        platform: "qq",
        transport: napcat,
      });
    }
    await runtime.start();
    app = await createHttpApplication({
      config: resolvedConfig,
      webGateway,
      setup,
      logger: httpLogger,
    });
    webUi = await registerWebUi(app, resolvedConfig);
    await app.listen({ host: resolvedConfig.host, port: resolvedConfig.port });

    if (resolvedConfig.napcat.enabled) {
      napcatLogger.info(
        {
          event: "napcat.connection.starting",
          adapterId: resolvedConfig.napcat.adapterId,
        },
        "NapCat connection starting",
      );
      await napcat?.start();
    }

    serverLogger.info(
      {
        event: "server.started",
        host: resolvedConfig.host,
        port: resolvedConfig.port,
        napcatEnabled: resolvedConfig.napcat.enabled,
      },
      "Kaguya server started",
    );
  } catch (error) {
    if (error instanceof StartupConfigurationError) {
      serverLogger.error(
        {
          event: "configuration.validation.failed",
          configRoot: error.configRoot,
          profileId: error.profileId,
          issueCount: error.issues.length,
          issues: error.issues,
          err: error,
        },
        "Startup configuration validation failed",
      );
      writeConfigurationFailure(error);
    } else {
      serverLogger.fatal(
        { event: "server.start.failed", err: error },
        "Kaguya server startup failed",
      );
    }
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

export async function createRuntimeModelSelectionResolver(
  configRoot: string,
): Promise<RuntimeModelSelectionResolver> {
  const manager = await FileUserConfigManager.open({ rootDir: configRoot });
  const selectedProfileId = manager.getSelectedProfileId();
  const profile = await manager.getProfile(selectedProfileId);
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
