/** Server composition root: adapter lifetimes and database checks remain independent of Runtime readiness. */
import {
  createReplyComposition,
  type RuntimeModelSelectionResolver,
} from "./runtime-composition.js";
import { pathToFileURL } from "node:url";

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
  type KaguyaLogger,
} from "@kaguya/logger";
import {
  KaguyaRuntime,
  RuntimeDatabaseInitializationError,
  runtimeInformationKindNames,
} from "@kaguya/runtime";
import type { FastifyInstance } from "fastify";

import { createHttpApplication } from "./app.js";
import {
  assertLoopbackHost,
  createServerConfig,
  readServerBootstrapConfig,
  type ServerConfig,
} from "./config.js";
import { createGatewayAuthenticator } from "./gateway-auth.js";
import {
  createNapCatSupervisor,
  type NapCatConnectionSupervisor,
} from "./napcat.js";
import { createConfigurationManagement } from "./setup.js";
import { AdapterHost } from "./adapter-host.js";
import type {
  AdapterConnectionStatus,
  RuntimeUnavailableReason,
} from "@kaguya/platform-adapters";
import { registerWebUi, type WebUiHandle } from "./web.js";

export interface StartedKaguyaServer {
  readonly app: FastifyInstance;
  readonly runtime?: KaguyaRuntime;
  readonly adapterHost: AdapterHost;
  close(): Promise<void>;
}

export async function startKaguyaServer(
  providedConfig?: ServerConfig,
): Promise<StartedKaguyaServer> {
  const bootstrap =
    providedConfig === undefined
      ? readServerBootstrapConfig()
      : {
          configRoot: providedConfig.configRoot,
          development: providedConfig.development,
        };
  let rootLogger: KaguyaLogger | undefined =
    providedConfig === undefined
      ? undefined
      : createLogger({
          service: "kaguya",
          level: providedConfig.logLevel,
          format: providedConfig.logFormat,
        });
  let serverLogger =
    rootLogger === undefined
      ? undefined
      : createModuleLogger(rootLogger, "server");
  let setup: Awaited<ReturnType<typeof createConfigurationManagement>>;
  let setupStatus: Awaited<ReturnType<typeof setup.inspect>>;
  let selectedProfile: UserConfigProfile;
  let config: ServerConfig;
  try {
    setup = await createConfigurationManagement(bootstrap.configRoot);
    setupStatus = await setup.inspect();
    selectedProfile = await setup.getProfile(setupStatus.selectedProfileId);
    config = providedConfig ?? createServerConfig(selectedProfile, bootstrap);
    assertLoopbackHost(config.host);
  } catch (error) {
    rootLogger ??= createLogger({ service: "kaguya" });
    serverLogger ??= createModuleLogger(rootLogger, "server");
    serverLogger.fatal(
      { event: "server.start.failed", errorType: safeErrorType(error) },
      "Kaguya server startup failed",
    );
    await closeResources({
      app: undefined,
      webUi: undefined,
      adapterHost: undefined,
      runtime: undefined,
      database: undefined,
      rootLogger,
      serverLogger,
    });
    throw error;
  }
  rootLogger ??= createLogger({
    service: "kaguya",
    level: config.logLevel,
    format: config.logFormat,
  });
  serverLogger ??= createModuleLogger(rootLogger, "server");
  const gatewayAuth = createGatewayAuthenticator(config.gatewayToken);
  const httpLogger = createModuleLogger(rootLogger, "server:http");
  const napcatLogger = createModuleLogger(rootLogger, "adapter:napcat");
  const adapterHost = new AdapterHost(rootLogger, config.gatewayAllowlist);
  let app: FastifyInstance | undefined;
  let webUi: WebUiHandle | undefined;
  let napcat: NapCatConnectionSupervisor | undefined;
  let closePromise: Promise<void> | undefined;
  let unregisterShutdown: (() => void) | undefined;
  let runtime: KaguyaRuntime | undefined;
  let failedRuntime: KaguyaRuntime | undefined;
  let database: KaguyaDatabase | undefined;

  const close = (): Promise<void> => {
    unregisterShutdown?.();
    closePromise ??= closeResources({
      app,
      webUi,
      adapterHost,
      runtime: runtime ?? failedRuntime,
      database,
      rootLogger,
      serverLogger,
    });
    return closePromise;
  };

  try {
    const effectiveConfig = config;
    adapterHost.register({
      adapterId: "web.ui.main",
      type: "web",
      platform: "web",
      enabled: true,
      start: async () => {},
      stop: async () => {},
    });
    let reportNapCatStatus:
      ((status: AdapterConnectionStatus) => void) | undefined;
    napcat = createNapCatSupervisor({
      config: config.napcat,
      ingress: adapterHost.ingress,
      logger: napcatLogger,
      allowsInbound: (message) => adapterHost.acceptInbound(message),
      reportStatus: (status) => reportNapCatStatus?.(status),
    });
    const napcatAdapter = napcat;
    adapterHost.register({
      adapterId: config.napcat.adapterId,
      type: "napcat",
      platform: "qq",
      enabled: config.napcat.enabled,
      ...(config.napcat.configurationError
        ? { configurationError: config.napcat.configurationError }
        : {}),
      outboundTransport: napcatAdapter,
      start: async (report) => {
        reportNapCatStatus = report;
        await napcatAdapter.start();
      },
      stop: () => napcatAdapter.stop(),
    });
    const degradationReasons: RuntimeUnavailableReason[] = [];
    let resolveModelSelection: RuntimeModelSelectionResolver | undefined;
    try {
      resolveModelSelection =
        createRuntimeModelSelectionResolver(selectedProfile);
    } catch {
      degradationReasons.push("configuration_not_ready");
    }
    // Database preflight runs even when AI configuration is incomplete.
    try {
      database = await connectInformationDatabase(effectiveConfig.databaseUrl);
      await prepareSetupDatabase(database);
    } catch {
      degradationReasons.push("database_unavailable");
    }
    if (
      resolveModelSelection &&
      database &&
      !degradationReasons.includes("database_unavailable")
    ) {
      try {
        runtime = new KaguyaRuntime({
          database,
          logger: rootLogger,
          ...createReplyComposition(resolveModelSelection, {
            memoryEnabled: selectedProfile.memory.enabled,
          }),
        });
        adapterHost.registerTransports(runtime);
        await startInformationRuntime(runtime);
      } catch (error) {
        degradationReasons.push(
          error instanceof InformationDatabaseConnectionError
            ? "database_unavailable"
            : "runtime_start_failed",
        );
        try {
          await runtime?.close();
        } catch {
          failedRuntime = runtime;
          serverLogger.warn(
            {
              event: "server.degraded.cleanup.failed",
              errorType: "runtime_close_failed",
            },
            "Partial Runtime cleanup failed",
          );
        }
        runtime = undefined;
      }
    }
    if (!runtime && database) {
      try {
        await database.close();
        database = undefined;
      } catch {
        serverLogger.warn(
          {
            event: "server.degraded.cleanup.failed",
            errorType: "database_close_failed",
          },
          "Database cleanup failed",
        );
      }
    }
    adapterHost.finalizeRuntime(runtime, degradationReasons[0]);
    for (const reason of degradationReasons)
      serverLogger.warn(
        { event: "server.degraded", reason },
        "Server downstream unavailable",
      );
    serverLogger.info(
      {
        event: "server.starting",
        host: config.host,
        port: config.port,
        napcatEnabled: config.napcat.enabled,
      },
      "Kaguya server starting",
    );
    app = await createHttpApplication({
      config: effectiveConfig,
      gatewayAuth,
      webGateway: adapterHost.webGateway,
      adapterHost,
      setup,
      logger: httpLogger,
    });
    webUi = await registerWebUi(app, effectiveConfig);
    await app.listen({
      host: effectiveConfig.host,
      port: effectiveConfig.port,
    });
    const listeningAddress = app.server.address();
    const listeningPort =
      typeof listeningAddress === "object" && listeningAddress !== null
        ? listeningAddress.port
        : effectiveConfig.port;
    process.stdout.write(
      `${formatAccessUrl({ ...effectiveConfig, port: listeningPort })}\n`,
    );

    await adapterHost.start();

    serverLogger.info(
      {
        event: "server.started",
        host: effectiveConfig.host,
        port: effectiveConfig.port,
        napcatEnabled: effectiveConfig.napcat.enabled,
        runtimeReady: runtime !== undefined,
        adapterHostState: adapterHost.status().adapterHostState,
        degradationReasons,
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
    adapterHost,
    ...(runtime === undefined ? {} : { runtime }),
    close,
  };
  unregisterShutdown = registerShutdownHandlers(started, serverLogger);
  return started;
}

export function formatAccessUrl(
  config: Pick<ServerConfig, "host" | "port" | "gatewayToken">,
): string {
  const host = config.host === "::1" ? "[::1]" : config.host;
  return `Kaguya access URL: http://${host}:${config.port}/#gatewayToken=${encodeURIComponent(config.gatewayToken)}`;
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
    return {
      providerId: provider.id,
      modelId: target.modelId,
      model: client.chatModel(target.modelId),
    };
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

async function prepareSetupDatabase(database: KaguyaDatabase): Promise<void> {
  try {
    await database.migrate();
    await database.information.synchronizeKinds(
      runtimeInformationKindNames(createReplyComposition().catalog),
    );
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
  readonly adapterHost: AdapterHost | undefined;
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
  options.adapterHost?.beginStopping();
  const ingressResults = await Promise.allSettled([
    options.app?.close() ?? Promise.resolve(),
    options.adapterHost?.stop() ?? Promise.resolve(),
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
): () => void {
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
  return () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
}

if (process.argv[1] !== undefined) {
  const entrypointUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entrypointUrl) {
    await startKaguyaServer().catch(() => {
      process.exitCode = 1;
    });
  }
}
