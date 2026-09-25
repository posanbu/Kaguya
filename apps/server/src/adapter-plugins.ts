/** Static adapter plugin registry. Plugin instances use global module configuration. */
import { createModuleLogger, type KaguyaLogger } from "@kaguya/logger";
import {
  createWebOutboundTransport,
  type AdapterConnectionStatus,
  type HostedAdapter,
} from "@kaguya/platform-adapters";
import { AdapterHost } from "./adapter-host.js";
import { createNapCatSupervisor } from "./napcat.js";
import type { NapCatConfig, ServerConfig } from "./config.js";

export interface AdapterPluginDefinition<Config> {
  readonly definitionId: string;
  readonly adapterId: string;
  readonly required: boolean;
  create(
    config: Config,
    host: AdapterHost,
    logger: KaguyaLogger,
  ): HostedAdapter;
}

export const webPlugin: AdapterPluginDefinition<undefined> = {
  definitionId: "adapter.web",
  adapterId: "web.ui.main",
  required: true,
  create: () => ({
    adapterId: "web.ui.main",
    type: "web",
    platform: "web",
    enabled: true,
    outboundTransport: createWebOutboundTransport(),
    start: async () => {},
    stop: async () => {},
  }),
};

export const napCatPlugin: AdapterPluginDefinition<NapCatConfig> = {
  definitionId: "adapter.napcat",
  adapterId: "napcat.qq.main",
  required: false,
  create(config, host, logger) {
    let reportStatus: ((status: AdapterConnectionStatus) => void) | undefined;
    const napcat = createNapCatSupervisor({
      config,
      ingress: host.ingress,
      logger: createModuleLogger(logger, "adapter:napcat"),
      allowsInbound: (message) => host.acceptInbound(message),
      reportStatus: (status) => reportStatus?.(status),
    });
    return {
      adapterId: config.adapterId,
      type: "napcat",
      platform: "qq",
      enabled: config.enabled,
      ...(config.configurationError
        ? { configurationError: config.configurationError }
        : {}),
      outboundTransport: napcat,
      targetDirectory: napcat,
      start: async (report) => {
        reportStatus = report;
        await napcat.start();
      },
      stop: () => napcat.stop(),
    };
  },
};

export const STATIC_ADAPTER_PLUGINS = [webPlugin, napCatPlugin] as const;

export function createServerAdapterHost(
  config: ServerConfig,
  logger: KaguyaLogger,
): AdapterHost {
  const host = new AdapterHost(logger, config.inboundAllowlist);
  host.register(webPlugin.create(undefined, host, logger));
  host.register(napCatPlugin.create(config.napcat, host, logger));
  return host;
}
