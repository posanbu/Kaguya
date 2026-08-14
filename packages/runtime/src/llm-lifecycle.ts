import { type EventBus } from "@kaguya/engine";
import { KaguyaLlmClient, type KaguyaLlmRequest } from "@kaguya/llm/client";
import type { KaguyaLlmOutputByKind } from "@kaguya/llm/schemas";
import type { EventEnvelope, LlmErrorKind } from "@kaguya/schema";
import type { ExecutionContext } from "@kaguya/sdk";

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
    context: ExecutionContext,
  ): Promise<KaguyaLlmOutputByKind[K]> {
    const lifecyclePayload = {
      kind: request.kind,
      modelId: request.modelId,
      workflowId: request.workflowId,
      nodeId: request.nodeId,
    };
    const sourceEvent = contextSourceEvent(context);
    const requestedEvent = llmRequestedEvent.create(
      eventBase(request.nodeId, context, sourceEvent),
      lifecyclePayload,
    );
    const requested = await emitDefinedEvent({
      definition: llmRequestedEvent,
      event: requestedEvent,
      eventBus: this.eventBus,
      validate: (candidate) =>
        protectLifecycleProvenance(requestedEvent, candidate),
    });

    let output: KaguyaLlmOutputByKind[K];
    try {
      output = await this.client.generate({
        ...request,
        traceRecordId: context.nextId("llm-trace"),
        ...(sourceEvent === undefined
          ? {}
          : {
              causationEventId: sourceEvent.id,
              rootEventId: causationRootEventId(sourceEvent),
            }),
      });
    } catch (error) {
      const failedEvent = llmFailedEvent.create(
        eventBase(request.nodeId, context, requested.event),
        {
          ...lifecyclePayload,
          error: lifecycleError(error),
        },
      );
      await emitDefinedEvent({
        definition: llmFailedEvent,
        event: failedEvent,
        eventBus: this.eventBus,
        validate: (candidate) =>
          protectLifecycleProvenance(failedEvent, candidate),
      });
      throw error;
    }

    const completedEvent = llmCompletedEvent.create(
      eventBase(request.nodeId, context, requested.event),
      lifecyclePayload,
    );
    await emitDefinedEvent({
      definition: llmCompletedEvent,
      event: completedEvent,
      eventBus: this.eventBus,
      validate: (candidate) =>
        protectLifecycleProvenance(completedEvent, candidate),
    });
    return output;
  }
}

function eventBase(
  nodeId: string,
  context: ExecutionContext,
  causation: EventEnvelope | undefined,
) {
  const rootEventId =
    causation === undefined ? undefined : causationRootEventId(causation);
  return {
    id: context.nextId("event"),
    source: `runtime-llm/${nodeId}`,
    occurredAt: context.now().toISOString(),
    traceId: context.traceId,
    metadata: {
      nodeId,
      ...(causation === undefined
        ? {}
        : { causationEventId: causation.id, rootEventId }),
      ...contextModuleIdentity(context),
    },
  };
}

function contextSourceEvent(
  context: ExecutionContext,
): EventEnvelope | undefined {
  if (
    !("sourceEvent" in context) ||
    typeof context.sourceEvent !== "object" ||
    context.sourceEvent === null ||
    !("id" in context.sourceEvent) ||
    !("traceId" in context.sourceEvent) ||
    typeof context.sourceEvent.id !== "string" ||
    context.sourceEvent.traceId !== context.traceId
  ) {
    return undefined;
  }
  return context.sourceEvent as EventEnvelope;
}

function contextModuleIdentity(
  context: ExecutionContext,
): Record<string, string> {
  if (
    !("definitionId" in context) ||
    !("instanceId" in context) ||
    typeof context.definitionId !== "string" ||
    typeof context.instanceId !== "string"
  ) {
    return {};
  }
  return {
    moduleDefinitionId: context.definitionId,
    moduleInstanceId: context.instanceId,
  };
}

function causationRootEventId(event: EventEnvelope): string {
  const root = event.metadata.rootEventId;
  return typeof root === "string" && root.length > 0 ? root : event.id;
}

function protectLifecycleProvenance(
  original: EventEnvelope,
  candidate: EventEnvelope,
): void {
  for (const key of ["id", "source", "occurredAt", "traceId"] as const) {
    if (candidate[key] !== original[key]) {
      throw new TypeError(`LLM lifecycle ${key} cannot be rewritten`);
    }
  }
  for (const key of [
    "causationEventId",
    "rootEventId",
    "moduleDefinitionId",
    "moduleInstanceId",
  ]) {
    if (candidate.metadata[key] !== original.metadata[key]) {
      throw new TypeError(`LLM lifecycle metadata.${key} cannot be rewritten`);
    }
  }
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
  const kind =
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "cancelled" ||
      error.kind === "non-retryable" ||
      error.kind === "retryable")
      ? error.kind
      : "non-retryable";
  const message =
    kind === "cancelled"
      ? "Language model generation was cancelled"
      : "Language model generation failed";
  return { name, message, kind };
}
