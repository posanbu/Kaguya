import { pathToFileURL } from "node:url";

import {
  createLocalMessageIngress,
  type LocalMessageIngress,
} from "@kaguya/demo";
import {
  closeLogger,
  createLogger,
  createModuleLogger,
  readLoggerOptions,
} from "@kaguya/logger";

import { createApiGateway } from "./app.js";
import {
  readApiGatewayConfig,
  type ApiGatewayConfig,
} from "./config.js";

export function createConfiguredMessageIngress(
  config: Pick<ApiGatewayConfig, "databasePath">,
): LocalMessageIngress {
  return createLocalMessageIngress({ databasePath: config.databasePath });
}

export async function startApiServer(): Promise<void> {
  const config = readApiGatewayConfig();
  const rootLogger = createLogger(readLoggerOptions("kaguya-api"));
  const logger = createModuleLogger(rootLogger, "api");
  const messageIngress = createConfiguredMessageIngress(config);
  const app = await createApiGateway({
    config,
    logger,
    messageIngress,
  });

  let closePromise: Promise<void> | undefined;
  const close = async () => {
    closePromise ??= (async () => {
      await app.close();
      messageIngress.close();
      await closeLogger(rootLogger);
    })();
    await closePromise;
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    logger.fatal(
      { event: "api.start.failed", err: error },
      "API startup failed",
    );
    process.exitCode = 1;
    await close();
  }
}

if (process.argv[1] !== undefined) {
  const entrypointUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entrypointUrl) {
    await startApiServer();
  }
}
