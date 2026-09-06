/**
 * 功能概述：实现 HTTP 消息路由到 Core 的窄 Web ingress 网关，仅负责
 * 正规化平台内容、调用 `InformationIngress.submit` 和观测异步失败。
 * 主要职责：`WebMessageGateway.ingest` 保持 HTTP 202 所需的非阻塞提交；
 * `createWebMessageGateway` 固定 adapter ID，拒绝无效输入，并以外部
 * `platformMessageId` 而非 trace 记录失败上下文。
 * 代码库关系：输入由 `@kaguya/platform-adapters` 的 Web 正规化器产生，
 * `app.ts` 只持有这个网关，`server.ts` 仅把 Runtime 当作结构性 ingress 注入。
 * 输入输出与副作用：ingest 同步校验并启动一次 submit，不等待 LLM/DAG 完成；
 * submit 拒绝被捕获并记录脱敏结构化上下文，不把 raw 或正文写入日志。
 */
import type { KaguyaLogger } from "@kaguya/logger";
import {
  normalizeWebInboundMessage,
  type InformationIngress,
  type WebInboundInput,
} from "@kaguya/platform-adapters";

export interface WebMessageGateway {
  ingest(input: WebInboundInput): void;
}

export interface CreateWebMessageGatewayOptions {
  readonly adapterId: string;
  readonly ingress: InformationIngress;
  readonly logger: KaguyaLogger;
}

export function createWebMessageGateway(
  options: CreateWebMessageGatewayOptions,
): WebMessageGateway {
  return {
    ingest(input) {
      const message = normalizeWebInboundMessage(input, {
        adapterId: options.adapterId,
      });
      if (message === undefined) {
        throw new Error("Web inbound message is invalid");
      }
      void options.ingress.submit(message).catch((error: unknown) => {
        options.logger.error(
          {
            event: "web.inbound.failed",
            platformMessageId: message.platformMessageId,
            adapterId: message.adapterId,
            err: error,
          },
          "Web inbound dispatch failed",
        );
      });
    },
  };
}
