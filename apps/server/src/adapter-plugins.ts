/**
 * 功能概述：静态 adapter 注册与实例组合，统一使用已加载的全局配置。
 * 主要职责：webPlugin/napCatPlugin 绑定宿主窄 ingress、状态回报及生命周期；
 * createServerAdapterHost 将采集目录固定在 configRoot/capture，开关/群范围不修改原有 allowlist。
 * 代码库关系：server.ts 通过本入口组装平台；NapCat supervisor 拥有同连接旁路采集和串行 journal。
 * 输入输出与副作用：工厂本身仅组合对象，实际连接与采集文件由 start/stop 管理。
 */
import { join } from "node:path";
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
    captureRoot?: string,
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
  create(config, host, logger, captureRoot) {
    let reportStatus: ((status: AdapterConnectionStatus) => void) | undefined;
    const napcat = createNapCatSupervisor({
      config,
      ingress: host.ingress,
      logger: createModuleLogger(logger, "adapter:napcat"),
      allowsInbound: (message) => host.acceptInbound(message),
      reportStatus: (status) => reportStatus?.(status),
      ...(captureRoot ? { captureRoot } : {}),
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
  host.register(
    napCatPlugin.create(
      config.napcat,
      host,
      logger,
      join(config.configRoot, "capture"),
    ),
  );
  return host;
}
