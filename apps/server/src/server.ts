import { pathToFileURL } from "node:url";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
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
import { registerWebUi, type WebUiHandle } from "./web.js";

export interface StartedKaguyaServer {
  readonly app: FastifyInstance;
  readonly runtime: KaguyaRuntime;
  close(): Promise<void>;
}

export async function startKaguyaServer(
  config: ServerConfig = readServerConfig(),
): Promise<StartedKaguyaServer> {
  const resolveModelSelection = await createRuntimeModelSelectionResolver(
    config.configRoot,
  );
  const rootLogger = createLogger(readLoggerOptions("kaguya"));
  const serverLogger = createModuleLogger(rootLogger, "server");
  const httpLogger = createModuleLogger(rootLogger, "server:http");
  const napcatLogger = createModuleLogger(rootLogger, "adapter:napcat");
  const runtime = new KaguyaRuntime({
    databasePath: config.databasePath,
    logger: rootLogger,
    resolveModelSelection,
  });

  let app: FastifyInstance | undefined;
  let webUi: WebUiHandle | undefined;
  let napcat: NapCatConnectionSupervisor | undefined;
  let closePromise: Promise<void> | undefined;

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
    serverLogger.info(
      {
        event: "server.starting",
        host: config.host,
        port: config.port,
        development: config.development,
        napcatEnabled: config.napcat.enabled,
      },
      "Kaguya server starting",
    );
    if (config.napcat.enabled) {
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
    await runtime.start();
    app = await createHttpApplication({
      config,
      runtime,
      logger: httpLogger,
    });
    webUi = await registerWebUi(app, config);
    await app.listen({ host: config.host, port: config.port });

    if (config.napcat.enabled) {
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
        napcatEnabled: config.napcat.enabled,
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

export async function createRuntimeModelSelectionResolver(
  configRoot: string,
): Promise<RuntimeModelSelectionResolver> {
  const manager = await FileUserConfigManager.open({ rootDir: configRoot });
  const defaultProfileId = manager.getDefaultProfileId();
  await manager.resolveProfileById(defaultProfileId);
  const profiles = new Map<string, UserConfigProfile>();
  for (const metadata of manager.listProfiles()) {
    profiles.set(metadata.id, await manager.getProfile(metadata.id));
  }
  const providerCache = new Map<
    string,
    ReturnType<typeof createOpenAICompatible>
  >();

  const resolver: RuntimeModelSelectionResolver = (selection) => {
    const profileId = selection.profileId ?? defaultProfileId;
    const profile = profiles.get(profileId);
    if (profile === undefined) {
      throw new Error(`Configuration profile was not found: ${profileId}`);
    }
    assertProfileReady(profile);
    const target = profile.ai.modelTiers?.[selection.modelTier];
    if (target === undefined) {
      throw new Error(
        `Model tier is unavailable in profile ${profileId}: ${selection.modelTier}`,
      );
    }
    const provider = profile.ai.providers.find(
      ({ id }) => id === target.providerId,
    );
    if (provider === undefined || !provider.enabled) {
      throw new Error(
        `Model tier provider is unavailable in profile ${profileId}`,
      );
    }
    if (provider.type !== "openai-compatible") {
      throw new Error(
        `Unsupported AI provider type in profile ${profileId}: ${provider.type}`,
      );
    }
    if (provider.apiKey === undefined || provider.baseUrl === undefined) {
      throw new Error(
        `AI provider credentials are incomplete in profile ${profileId}`,
      );
    }
    const cacheKey = `${profileId}:${provider.id}`;
    let client = providerCache.get(cacheKey);
    if (client === undefined) {
      client = createOpenAICompatible({
        name: `kaguya-${profileId}-${provider.id}`,
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
  readonly runtime: KaguyaRuntime;
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

  try {
    await options.runtime.close();
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
