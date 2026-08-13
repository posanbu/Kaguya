import { z } from "@kaguya/schema";
import {
  defineEvent,
  defineModule,
  onEvent,
  onTargetedEvent,
  type ModuleDefinition,
} from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

import { EventBus } from "./event-bus.js";
import {
  ModuleDefinitionNotFoundError,
  ModuleHost,
  ModuleTargetNotFoundError,
} from "./module-host.js";

const broadcastEvent = defineEvent(
  "module.test.broadcast",
  z.object({ value: z.string() }).strict(),
  { sessionScoped: true },
);
const targetedEvent = defineEvent(
  "module.test.targeted",
  z.object({ targetInstanceId: z.string().min(1), value: z.string() }).strict(),
  { sessionScoped: true },
);

function baseEvent<TType extends string, TPayload>(
  definition: Parameters<typeof createHostEvent<TType, TPayload>>[0],
  payload: TPayload,
) {
  return createHostEvent(definition, payload);
}

function createHostEvent<TType extends string, TPayload>(
  definition: {
    create(
      base: {
        id: string;
        source: string;
        occurredAt: string;
        traceId: string;
        sessionId: string;
        metadata: Record<string, unknown>;
      },
      payload: TPayload,
    ): unknown;
  },
  payload: TPayload,
) {
  return definition.create(
    {
      id: "event-1",
      source: "test",
      occurredAt: "2026-08-13T00:00:00.000Z",
      traceId: "trace-1",
      sessionId: "session-1",
      metadata: {},
    },
    payload,
  ) as ReturnType<(typeof broadcastEvent)["create"]>;
}

function host(eventBus = new EventBus()) {
  let sequence = 0;
  return {
    eventBus,
    host: new ModuleHost({
      eventBus,
      now: () => new Date("2026-08-13T00:00:01.000Z"),
      nextId: (traceId, prefix) => `${traceId}-${prefix}-${++sequence}`,
    }),
  };
}

function definition(
  definitionId: string,
  handlers: {
    readonly broadcast?: (value: string) => Promise<void> | void;
    readonly targeted?: (value: string) => Promise<void> | void;
  },
): ModuleDefinition<{ label: string }> {
  return defineModule({
    manifest: {
      apiVersion: 1,
      definitionId,
      displayName: definitionId,
      settingsSchema: z.object({ label: z.string().min(1) }).strict(),
    },
    create: () => ({
      subscriptions: [
        ...(handlers.broadcast === undefined
          ? []
          : [
              onEvent(broadcastEvent, async (event) => {
                await handlers.broadcast?.(event.payload.value);
              }),
            ]),
        ...(handlers.targeted === undefined
          ? []
          : [
              onTargetedEvent(targetedEvent, async (event) => {
                await handlers.targeted?.(event.payload.value);
              }),
            ]),
      ],
    }),
  });
}

describe("ModuleHost", () => {
  it("validates every activation before creating any module", async () => {
    const runtime = host();
    let created = 0;
    const module = defineModule({
      manifest: {
        apiVersion: 1,
        definitionId: "test.validated",
        displayName: "Validated",
        settingsSchema: z.object({ value: z.string().min(1) }).strict(),
      },
      create: () => {
        created += 1;
        return { subscriptions: [] };
      },
    });
    runtime.host.register(module);

    await expect(
      runtime.host.start([
        {
          instanceId: "valid",
          definitionId: "test.validated",
          settings: { value: "yes" },
        },
        {
          instanceId: "invalid",
          definitionId: "test.validated",
          settings: { value: "" },
        },
      ]),
    ).rejects.toThrow();
    expect(created).toBe(0);
  });

  it("rejects duplicate registrations, instances, and missing definitions", async () => {
    const runtime = host();
    const module = definition("test.one", {});
    runtime.host.register(module);
    expect(() => runtime.host.register(module)).toThrow(
      "Duplicate module definition id",
    );
    await expect(
      runtime.host.start([
        {
          instanceId: "same",
          definitionId: "test.one",
          settings: { label: "one" },
        },
        {
          instanceId: "same",
          definitionId: "test.one",
          settings: { label: "two" },
        },
      ]),
    ).rejects.toThrow("Duplicate module instance id");

    const missing = host().host;
    await expect(
      missing.start([
        { instanceId: "x", definitionId: "missing", settings: {} },
      ]),
    ).rejects.toBeInstanceOf(ModuleDefinitionNotFoundError);
  });

  it("fans broadcast events out and reports failures after all handlers run", async () => {
    const runtime = host();
    const calls: string[] = [];
    runtime.host.register(
      definition("test.good", {
        broadcast: (value) => {
          calls.push(value);
        },
      }),
    );
    runtime.host.register(
      definition("test.bad", {
        broadcast: () => {
          calls.push("bad");
          throw new Error("broken module");
        },
      }),
    );
    await runtime.host.start([
      {
        instanceId: "good",
        definitionId: "test.good",
        settings: { label: "good" },
      },
      {
        instanceId: "bad",
        definitionId: "test.bad",
        settings: { label: "bad" },
      },
    ]);

    await expect(
      runtime.eventBus.emit(baseEvent(broadcastEvent, { value: "received" })),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(expect.arrayContaining(["received", "bad"]));
  });

  it("routes targeted events to one instance and rejects unknown targets", async () => {
    const runtime = host();
    const calls: string[] = [];
    const module = definition("test.target", {
      targeted: (value) => {
        calls.push(value);
      },
    });
    runtime.host.register(module);
    runtime.host.register(definition("test.passive", { broadcast: () => {} }));
    await runtime.host.start([
      {
        instanceId: "target.one",
        definitionId: "test.target",
        settings: { label: "one" },
      },
      {
        instanceId: "target.two",
        definitionId: "test.target",
        settings: { label: "two" },
      },
      {
        instanceId: "target.passive",
        definitionId: "test.passive",
        settings: { label: "passive" },
      },
    ]);

    await runtime.eventBus.emit(
      baseEvent(targetedEvent, {
        targetInstanceId: "target.two",
        value: "only-two",
      }),
    );
    expect(calls).toEqual(["only-two"]);
    await expect(
      runtime.eventBus.emit(
        baseEvent(targetedEvent, {
          targetInstanceId: "missing",
          value: "nope",
        }),
      ),
    ).rejects.toBeInstanceOf(ModuleTargetNotFoundError);
    await expect(
      runtime.eventBus.emit(
        baseEvent(targetedEvent, {
          targetInstanceId: "target.passive",
          value: "unsupported",
        }),
      ),
    ).rejects.toBeInstanceOf(ModuleTargetNotFoundError);
    expect(() => runtime.host.register(definition("test.late", {}))).toThrow(
      "before start",
    );
  });

  it("emits derived events with inherited identity and module causation", async () => {
    const runtime = host();
    const derived: unknown[] = [];
    runtime.eventBus.subscribe(
      targetedEvent.type,
      (event) => {
        derived.push(event);
      },
      { mode: "observe" },
    );
    runtime.host.register(
      defineModule({
        manifest: {
          apiVersion: 1,
          definitionId: "test.emitter",
          displayName: "Emitter",
          settingsSchema: z.object({ target: z.string() }).strict(),
        },
        create: ({ settings }) => ({
          subscriptions: [
            onEvent(broadcastEvent, async (event, context) => {
              await context.emit(targetedEvent, {
                targetInstanceId: settings.target,
                value: event.payload.value,
              });
            }),
          ],
        }),
      }),
    );
    runtime.host.register(definition("test.receiver", { targeted: () => {} }));
    await runtime.host.start([
      {
        instanceId: "emitter",
        definitionId: "test.emitter",
        settings: { target: "receiver" },
      },
      {
        instanceId: "receiver",
        definitionId: "test.receiver",
        settings: { label: "receiver" },
      },
    ]);

    await runtime.eventBus.emit(
      baseEvent(broadcastEvent, { value: "derived" }),
    );
    expect(derived).toContainEqual(
      expect.objectContaining({
        source: "module:emitter",
        traceId: "trace-1",
        sessionId: "session-1",
        payload: { targetInstanceId: "receiver", value: "derived" },
        metadata: expect.objectContaining({
          causationEventId: "event-1",
          moduleDefinitionId: "test.emitter",
          moduleInstanceId: "emitter",
        }),
      }),
    );
  });

  it("does not deduplicate requests emitted by multiple module instances", async () => {
    const runtime = host();
    const received: string[] = [];
    runtime.host.register(
      defineModule({
        manifest: {
          apiVersion: 1,
          definitionId: "test.multi-emitter",
          displayName: "Multi emitter",
          settingsSchema: z.object({ target: z.string() }).strict(),
        },
        create: ({ instanceId, settings }) => ({
          subscriptions: [
            onEvent(broadcastEvent, async (_event, context) => {
              await context.emit(targetedEvent, {
                targetInstanceId: settings.target,
                value: instanceId,
              });
            }),
          ],
        }),
      }),
    );
    runtime.host.register(
      definition("test.multi-receiver", {
        targeted: (value) => {
          received.push(value);
        },
      }),
    );
    await runtime.host.start([
      {
        instanceId: "filter.one",
        definitionId: "test.multi-emitter",
        settings: { target: "reply.default" },
      },
      {
        instanceId: "filter.two",
        definitionId: "test.multi-emitter",
        settings: { target: "reply.default" },
      },
      {
        instanceId: "reply.default",
        definitionId: "test.multi-receiver",
        settings: { label: "reply" },
      },
    ]);

    await runtime.eventBus.emit(
      baseEvent(broadcastEvent, { value: "message" }),
    );

    expect(received.sort()).toEqual(["filter.one", "filter.two"]);
  });

  it("unsubscribes all instances on stop", async () => {
    const runtime = host();
    let calls = 0;
    let disposals = 0;
    runtime.host.register(
      defineModule({
        manifest: {
          apiVersion: 1,
          definitionId: "test.stop",
          displayName: "Stop",
          settingsSchema: z.object({ label: z.string() }).strict(),
        },
        create: () => ({
          subscriptions: [
            onEvent(broadcastEvent, () => {
              calls += 1;
            }),
          ],
          dispose: () => {
            disposals += 1;
          },
        }),
      }),
    );
    await runtime.host.start([
      {
        instanceId: "stop",
        definitionId: "test.stop",
        settings: { label: "stop" },
      },
    ]);
    await runtime.host.stop();
    await runtime.eventBus.emit(
      baseEvent(broadcastEvent, { value: "ignored" }),
    );
    expect(calls).toBe(0);
    expect(disposals).toBe(1);
  });
});
