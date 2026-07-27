import { createApiGateway } from "./app.js";
import { readApiGatewayConfig } from "./config.js";

const config = readApiGatewayConfig();
const app = await createApiGateway({
  config,
  logger: true,
});

const close = async () => {
  await app.close();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
