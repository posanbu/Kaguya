import type { KaguyaLogger } from "@kaguya/logger";
import {
  normalizeWebInboundMessage,
  type WebInboundInput,
} from "@kaguya/platform-adapters";
import type { KaguyaRuntime } from "@kaguya/runtime";

export interface WebMessageGateway {
  ingest(input: WebInboundInput): void;
}

export interface CreateWebMessageGatewayOptions {
  readonly adapterId: string;
  readonly runtime: KaguyaRuntime;
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
      void options.runtime
        .dispatch({ kind: "platform", message })
        .catch((error: unknown) => {
          options.logger.error(
            {
              event: "web.inbound.failed",
              traceId: message.traceId,
              adapterId: message.adapterId,
              err: error,
            },
            "Web inbound dispatch failed",
          );
        });
    },
  };
}
