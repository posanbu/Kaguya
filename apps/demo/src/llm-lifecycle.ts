import { type EventBus } from "@kaguya/engine";
import { KaguyaLlmClient, type KaguyaLlmRequest } from "@kaguya/llm/client";
import type { KaguyaLlmOutputByKind } from "@kaguya/llm/schemas";
import type { LlmErrorKind } from "@kaguya/schema";
import type { WorkflowContext } from "@kaguya/sdk";

import { emitDefinedEvent } from "./dispatch.js";
import {
  llmCompletedEvent,
  llmFailedEvent,
  llmRequestedEvent,
} from "./events.js";

export class LlmLifecycleClient {
  constructor(
    private readonly client: KaguyaLlmClient,
    private readonly eventBus: EventBus,
  ) {}

  async generate<K extends KaguyaLlmRequest["kind"]>(
    request: KaguyaLlmRequest & { kind: K },
    context: WorkflowContext,
  ): Promise<KaguyaLlmOutputByKind[K]> {
    const lifecyclePayload = {
      kind: request.kind,
      modelId: request.modelId,
      workflowId: request.workflowId,
      nodeId: request.nodeId,
    };
    await emitDefinedEvent({
      definition: llmRequestedEvent,
      event: llmRequestedEvent.create(
        eventBase(request.nodeId, context),
        lifecyclePayload,
      ),
      eventBus: this.eventBus,
    });

    let output: KaguyaLlmOutputByKind[K];
    try {
      output = await this.client.generate(request);
    } catch (error) {
      await emitDefinedEvent({
        definition: llmFailedEvent,
        event: llmFailedEvent.create(eventBase(request.nodeId, context), {
          ...lifecyclePayload,
          error: lifecycleError(error),
        }),
        eventBus: this.eventBus,
      });
      throw error;
    }

    await emitDefinedEvent({
      definition: llmCompletedEvent,
      event: llmCompletedEvent.create(
        eventBase(request.nodeId, context),
        lifecyclePayload,
      ),
      eventBus: this.eventBus,
    });
    return output;
  }
}

function eventBase(nodeId: string, context: WorkflowContext) {
  if (context.sessionId === undefined) {
    throw new Error("LLM lifecycle events require a sessionId");
  }
  return {
    id: context.nextId("event"),
    source: `demo-llm/${nodeId}`,
    occurredAt: context.now().toISOString(),
    traceId: context.traceId,
    sessionId: context.sessionId,
    metadata: { nodeId },
  };
}

function lifecycleError(error: unknown): {
  name: string;
  message: string;
  kind: LlmErrorKind;
} {
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    error.name.length > 0
      ? error.name
      : "Error";
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "Language model generation failed";
  const kind =
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "cancelled" ||
      error.kind === "non-retryable" ||
      error.kind === "retryable")
      ? error.kind
      : "non-retryable";
  return { name, message, kind };
}
