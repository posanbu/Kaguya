import {
  EventValidationError,
  type EventBus,
  type InterceptResult,
  type WorkflowEngine,
  type WorkflowExecutionResult,
} from "@kaguya/engine";
import { eventEnvelopeSchema, type EventEnvelope } from "@kaguya/schema";
import type {
  EventDefinition,
  WorkflowContext,
  WorkflowDefinition,
} from "@kaguya/sdk";

export interface DispatchEventOptions<TType extends string, TPayload> {
  definition: EventDefinition<TType, TPayload>;
  event: EventEnvelope<TType, TPayload>;
  eventBus: EventBus;
  engine: WorkflowEngine;
  workflow: WorkflowDefinition;
  context: WorkflowContext;
}

export interface EmitDefinedEventOptions<TType extends string, TPayload> {
  definition: EventDefinition<TType, TPayload>;
  event: EventEnvelope<TType, TPayload>;
  eventBus: EventBus;
  validate?: (event: EventEnvelope<TType, TPayload>) => void;
}

export async function emitDefinedEvent<TType extends string, TPayload>({
  definition,
  event,
  eventBus,
  validate,
}: EmitDefinedEventOptions<TType, TPayload>): Promise<
  InterceptResult<EventEnvelope<TType, TPayload>>
> {
  const validatedEvent = validateDefinedEvent(definition, event);
  return eventBus.emit(validatedEvent, {
    validate: (rewrittenEvent) => {
      validate?.(validateDefinedEvent(definition, rewrittenEvent));
    },
  });
}

export async function dispatchEvent<TType extends string, TPayload>({
  definition,
  event,
  eventBus,
  engine,
  workflow,
  context,
}: DispatchEventOptions<TType, TPayload>): Promise<
  WorkflowExecutionResult | undefined
> {
  const dispatched = await emitDefinedEvent({
    definition,
    event,
    eventBus,
    validate: (candidate) => {
      validateContextIdentity(candidate, context);
    },
  });
  if (!dispatched.continue) {
    return undefined;
  }

  const validatedRewrite = validateDefinedEvent(definition, dispatched.event);
  validateContextIdentity(validatedRewrite, context);
  return engine.run(workflow, validatedRewrite, context);
}

function validateDefinedEvent<TType extends string, TPayload>(
  definition: EventDefinition<TType, TPayload>,
  event: EventEnvelope,
): EventEnvelope<TType, TPayload> {
  let envelope: EventEnvelope;
  try {
    const parsed = eventEnvelopeSchema.parse(event);
    envelope = {
      id: parsed.id,
      type: parsed.type,
      source: parsed.source,
      occurredAt: parsed.occurredAt,
      traceId: parsed.traceId,
      ...(parsed.sessionId === undefined
        ? {}
        : { sessionId: parsed.sessionId }),
      payload: parsed.payload,
      metadata: parsed.metadata,
    };
  } catch (cause) {
    throw new EventValidationError(eventTypeOf(event), cause);
  }

  if (envelope.type !== definition.type) {
    throw new EventValidationError(
      envelope.type,
      new TypeError(
        `Expected event type "${definition.type}", received "${envelope.type}"`,
      ),
      "definition",
    );
  }

  let payload: TPayload;
  try {
    payload = definition.payloadSchema.parse(envelope.payload);
  } catch (cause) {
    throw new EventValidationError(definition.type, cause, "payload");
  }

  if (definition.sessionScoped && envelope.sessionId === undefined) {
    throw new EventValidationError(
      definition.type,
      new TypeError(`${definition.type} requires sessionId`),
      "definition",
    );
  }

  return {
    ...envelope,
    type: definition.type,
    payload,
  };
}

function validateContextIdentity(
  event: EventEnvelope,
  context: Pick<WorkflowContext, "sessionId" | "traceId">,
): void {
  if (event.traceId !== context.traceId) {
    throw new EventValidationError(
      event.type,
      new TypeError("event traceId does not match workflow context"),
      "definition",
    );
  }
  if (event.sessionId !== context.sessionId) {
    throw new EventValidationError(
      event.type,
      new TypeError("event sessionId does not match workflow context"),
      "definition",
    );
  }
}

function eventTypeOf(event: unknown): string {
  if (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    typeof event.type === "string"
  ) {
    return event.type;
  }
  return "<invalid>";
}
