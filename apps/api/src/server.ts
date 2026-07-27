import {
  closeLogger,
  createLogger,
  createModuleLogger,
  readLoggerOptions,
} from "@kaguya/logger";

import { createApiGateway } from "./app.js";
import { readApiGatewayConfig } from "./config.js";

const config = readApiGatewayConfig();
const rootLogger = createLogger(readLoggerOptions("kaguya-api"));
const logger = createModuleLogger(rootLogger, "api");
const app = await createApiGateway({
  config,
  logger,
});

let closePromise: Promise<void> | undefined;
const close = async () => {
  closePromise ??= (async () => {
    await app.close();
    await closeLogger(rootLogger);
  })();
  await closePromise;
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logger.fatal({ event: "api.start.failed", err: error }, "API startup failed");
  process.exitCode = 1;
  await close();
}
