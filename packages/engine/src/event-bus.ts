import { eventEnvelopeSchema, type EventEnvelope } from "@kaguya/schema";
import type { ListenerOptions } from "@kaguya/sdk";

export interface InterceptResult<TEvent extends EventEnvelope = EventEnvelope> {
  continue: boolean;
  event: TEvent;
}

export interface EventBusOptions {
  onObserverError?: (error: unknown) => void | Promise<void>;
}

export type EventCloneField = "metadata" | "payload";
export type EventValidationPhase = "definition" | "envelope" | "payload";

export class EventCloneError extends TypeError {
  constructor(
    readonly eventType: string,
    readonly field: EventCloneField,
    cause: unknown,
  ) {
    super(
      `Cannot clone ${field} for event "${eventType}": event data must be structured-cloneable`,
      { cause },
    );
    this.name = "EventCloneError";
  }
}

export class EventValidationError extends TypeError {
  constructor(
    readonly eventType: string,
    cause: unknown,
    readonly phase: EventValidationPhase = "envelope",
  ) {
    super(`Invalid event ${phase} for "${eventType}"`, { cause });
    this.name = "EventValidationError";
  }
}

export interface EventEmitOptions<TEvent extends EventEnvelope> {
  validate?: (event: TEvent) => void;
}

type EventRecord = EventEnvelope<string, Record<string, unknown>>;
type Interceptor = (
  event: EventRecord,
) => InterceptResult<EventRecord> | Promise<InterceptResult<EventRecord>>;
type Observer = (event: EventRecord) => unknown | Promise<unknown>;

interface Subscription {
  type: string;
  handler: Interceptor | Observer;
  mode: "intercept" | "observe";
  priority: number;
}

export class EventBus {
  private readonly subscriptions: Subscription[] = [];

  constructor(private readonly options: EventBusOptions = {}) {}

  subscribe<TType extends string>(
    type: TType,
    handler: (
      event: EventEnvelope<TType, Record<string, unknown>>,
    ) =>
      | InterceptResult<EventEnvelope<TType, Record<string, unknown>>>
      | Promise<InterceptResult<EventEnvelope<TType, Record<string, unknown>>>>,
    options?: ListenerOptions & { mode?: "intercept" },
  ): () => void;
  subscribe<TType extends string>(
    type: TType,
    handler: (
      event: EventEnvelope<TType, Record<string, unknown>>,
    ) => unknown | Promise<unknown>,
    options: ListenerOptions & { mode: "observe" },
  ): () => void;
  subscribe<TType extends string>(
    type: TType,
    handler: Interceptor | Observer,
    options: ListenerOptions = {},
  ): () => void {
    const subscription: Subscription = {
      type,
      handler,
      mode: options.mode ?? "intercept",
      priority: options.priority ?? 0,
    };
    this.subscriptions.push(subscription);

    return () => {
      const index = this.subscriptions.indexOf(subscription);
      if (index >= 0) {
        this.subscriptions.splice(index, 1);
      }
    };
  }

  async emit<TEvent extends EventEnvelope>(
    event: TEvent,
    options: EventEmitOptions<TEvent> = {},
  ): Promise<InterceptResult<TEvent>> {
    validateEventEnvelope(event);
    options.validate?.(event);
    let result: InterceptResult<EventRecord> = {
      continue: true,
      event: cloneEvent(event) as EventRecord,
    };
    const subscriptions = this.subscriptions
      .filter((subscription) => subscription.type === event.type)
      .sort((left, right) => right.priority - left.priority);

    for (const subscription of subscriptions) {
      if (subscription.mode !== "intercept") {
        continue;
      }

      const nextResult = await (subscription.handler as Interceptor)(
        result.event,
      );
      validateEventEnvelope(nextResult.event);
      options.validate?.(nextResult.event as TEvent);
      result = nextResult;
      if (!result.continue) {
        return result as InterceptResult<TEvent>;
      }
    }

    const observerResults = await Promise.allSettled(
      subscriptions
        .filter((subscription) => subscription.mode === "observe")
        .map((subscription) =>
          Promise.resolve().then(() =>
            (subscription.handler as Observer)(cloneEvent(result.event)),
          ),
        ),
    );
    for (const observerResult of observerResults) {
      if (observerResult.status === "rejected") {
        await this.reportObserverError(observerResult.reason);
      }
    }

    return result as InterceptResult<TEvent>;
  }

  private async reportObserverError(error: unknown): Promise<void> {
    try {
      await this.options.onObserverError?.(error);
    } catch {
      // Observer error reporting must not affect the emitted business result.
    }
  }
}

function validateEventEnvelope(event: unknown): asserts event is EventEnvelope {
  try {
    eventEnvelopeSchema.parse(event);
  } catch (cause) {
    throw new EventValidationError(eventTypeOf(event), cause);
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

function cloneEvent<TEvent extends EventEnvelope>(event: TEvent): TEvent {
  return {
    ...event,
    metadata: cloneEventData(event.metadata, event.type, "metadata"),
    payload: cloneEventData(event.payload, event.type, "payload"),
  };
}

function cloneEventData<TValue>(
  value: TValue,
  eventType: string,
  field: EventCloneField,
): TValue {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new EventCloneError(eventType, field, cause);
  }
}
