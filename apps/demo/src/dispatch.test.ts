import { EventBus, WorkflowEngine } from "@kaguya/engine";
import type { EventEnvelope } from "@kaguya/schema";
import { z } from "@kaguya/schema";
import {
  defineEvent,
  defineNode,
  defineWorkflow,
  type EventDefinition,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

const NOW = "2026-07-23T12:00:00.000Z";
const inputEvent = defineEvent(
  "test.input",
  z.object({ text: z.string().trim().min(1) }).strict(),
  { sessionScoped: true },
);

function createBoundaryHarness() {
  const handlerEffect = vi.fn();
  const recorderEffect = vi.fn(() => Promise.resolve());
  const repositoryEffect = vi.fn();
  const llmEffect = vi.fn();
  const eventBus = new EventBus();
  const engine = new WorkflowEngine({
    recorder: { record: recorderEffect },
  });
  const workflow = defineWorkflow({
    id: "dispatch-boundary-workflow",
    nodes: [
      defineNode({
        id: "effectful-node",
        async run(event: EventEnvelope) {
          repositoryEffect(event);
          llmEffect(event);
          return event;
        },
      }),
    ],
    edges: [],
  });
  const context: WorkflowContext = {
    traceId: "trace-dispatch",
    sessionId: "session-dispatch",
    now: () => new Date(NOW),
    nextId: (prefix) => `${prefix}-1`,
    services: {},
  };
  eventBus.subscribe("test.input", handlerEffect, { mode: "observe" });

  return {
    context,
    engine,
    eventBus,
    handlerEffect,
    llmEffect,
    recorderEffect,
    repositoryEffect,
    workflow,
  };
}

async function dispatch<TType extends string, TPayload>(options: {
  definition: EventDefinition<TType, TPayload>;
  event: EventEnvelope<TType, TPayload>;
  eventBus: EventBus;
  engine: WorkflowEngine;
  workflow: WorkflowDefinition;
  context: WorkflowContext;
}) {
  const dispatchModule = await import("./dispatch.js").catch(() => ({
    dispatchEvent: undefined,
  }));
  expect(dispatchModule.dispatchEvent).toBeTypeOf("function");
  if (typeof dispatchModule.dispatchEvent !== "function") {
    throw new Error("dispatchEvent is unavailable");
  }
  return dispatchModule.dispatchEvent(options);
}

describe("application event dispatch boundary", () => {
  it.each([
    {
      identity: "traceId",
      traceId: "trace-other",
      sessionId: "session-dispatch",
    },
    {
      identity: "sessionId",
      traceId: "trace-dispatch",
      sessionId: "session-other",
    },
  ])(
    "rejects an initial $identity mismatch before any handler or workflow effect",
    async ({ traceId, sessionId }) => {
      const harness = createBoundaryHarness();
      const interceptorEffect = vi.fn((event) => ({ continue: true, event }));
      harness.eventBus.subscribe("test.input", interceptorEffect, {
        mode: "intercept",
      });
      const event = inputEvent.create(
        {
          id: `event-initial-${traceId}-${sessionId}`,
          source: "test",
          occurredAt: NOW,
          traceId,
          sessionId,
          metadata: {},
        },
        { text: "valid payload" },
      );

      await expect(
        dispatch({
          definition: inputEvent,
          event,
          eventBus: harness.eventBus,
          engine: harness.engine,
          workflow: harness.workflow,
          context: harness.context,
        }),
      ).rejects.toMatchObject({
        name: "EventValidationError",
        eventType: "test.input",
        phase: "definition",
        cause: expect.anything(),
      });
      expect(interceptorEffect).not.toHaveBeenCalled();
      expect(harness.handlerEffect).not.toHaveBeenCalled();
      expect(harness.recorderEffect).not.toHaveBeenCalled();
      expect(harness.repositoryEffect).not.toHaveBeenCalled();
      expect(harness.llmEffect).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      identity: "traceId",
      rewrite: { traceId: "trace-other" },
    },
    {
      identity: "sessionId",
      rewrite: { sessionId: "session-other" },
    },
  ])(
    "rejects an interceptor $identity rewrite before later handlers or workflow effects",
    async ({ rewrite }) => {
      const harness = createBoundaryHarness();
      const laterInterceptor = vi.fn((event) => ({ continue: true, event }));
      harness.eventBus.subscribe(
        "test.input",
        (event) => ({
          continue: true,
          event: { ...event, ...rewrite },
        }),
        { priority: 10, mode: "intercept" },
      );
      harness.eventBus.subscribe("test.input", laterInterceptor, {
        priority: 0,
        mode: "intercept",
      });
      const event = inputEvent.create(
        {
          id: `event-rewritten-${String(Object.keys(rewrite)[0])}`,
          source: "test",
          occurredAt: NOW,
          traceId: harness.context.traceId,
          sessionId: "session-dispatch",
          metadata: {},
        },
        { text: "valid payload" },
      );

      await expect(
        dispatch({
          definition: inputEvent,
          event,
          eventBus: harness.eventBus,
          engine: harness.engine,
          workflow: harness.workflow,
          context: harness.context,
        }),
      ).rejects.toMatchObject({
        name: "EventValidationError",
        eventType: "test.input",
        phase: "definition",
        cause: expect.anything(),
      });
      expect(laterInterceptor).not.toHaveBeenCalled();
      expect(harness.handlerEffect).not.toHaveBeenCalled();
      expect(harness.recorderEffect).not.toHaveBeenCalled();
      expect(harness.repositoryEffect).not.toHaveBeenCalled();
      expect(harness.llmEffect).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed envelope before any handler or workflow effect", async () => {
    const harness = createBoundaryHarness();
    const event = {
      id: "event-malformed-envelope",
      type: "test.input",
      source: "test",
      occurredAt: "not-an-iso-datetime",
      traceId: harness.context.traceId,
      sessionId: harness.context.sessionId,
      payload: { text: "valid payload" },
      metadata: {},
    } as EventEnvelope<"test.input", { text: string }>;

    await expect(
      dispatch({
        definition: inputEvent,
        event,
        eventBus: harness.eventBus,
        engine: harness.engine,
        workflow: harness.workflow,
        context: harness.context,
      }),
    ).rejects.toMatchObject({
      name: "EventValidationError",
      eventType: "test.input",
      cause: expect.anything(),
    });
    expect(harness.handlerEffect).not.toHaveBeenCalled();
    expect(harness.recorderEffect).not.toHaveBeenCalled();
    expect(harness.repositoryEffect).not.toHaveBeenCalled();
    expect(harness.llmEffect).not.toHaveBeenCalled();
  });

  it("rejects a malformed concrete payload before any handler or workflow effect", async () => {
    const harness = createBoundaryHarness();
    const event = {
      id: "event-malformed-payload",
      type: "test.input",
      source: "test",
      occurredAt: NOW,
      traceId: harness.context.traceId,
      sessionId: harness.context.sessionId,
      payload: { text: "   " },
      metadata: {},
    } as EventEnvelope<"test.input", { text: string }>;

    await expect(
      dispatch({
        definition: inputEvent,
        event,
        eventBus: harness.eventBus,
        engine: harness.engine,
        workflow: harness.workflow,
        context: harness.context,
      }),
    ).rejects.toMatchObject({
      name: "EventValidationError",
      eventType: "test.input",
      phase: "payload",
      cause: expect.anything(),
    });
    expect(harness.handlerEffect).not.toHaveBeenCalled();
    expect(harness.recorderEffect).not.toHaveBeenCalled();
    expect(harness.repositoryEffect).not.toHaveBeenCalled();
    expect(harness.llmEffect).not.toHaveBeenCalled();
  });

  it("rejects a malformed interceptor payload before later handlers or workflow effects", async () => {
    const harness = createBoundaryHarness();
    const laterInterceptor = vi.fn((event) => ({ continue: true, event }));
    harness.eventBus.subscribe(
      "test.input",
      (event) => ({
        continue: true,
        event: { ...event, payload: { text: " " } },
      }),
      { priority: 10, mode: "intercept" },
    );
    harness.eventBus.subscribe("test.input", laterInterceptor, {
      priority: 0,
      mode: "intercept",
    });
    const event = inputEvent.create(
      {
        id: "event-invalid-rewrite",
        source: "test",
        occurredAt: NOW,
        traceId: harness.context.traceId,
        sessionId: "session-dispatch",
        metadata: {},
      },
      { text: "valid payload" },
    );

    await expect(
      dispatch({
        definition: inputEvent,
        event,
        eventBus: harness.eventBus,
        engine: harness.engine,
        workflow: harness.workflow,
        context: harness.context,
      }),
    ).rejects.toMatchObject({
      name: "EventValidationError",
      eventType: "test.input",
      phase: "payload",
    });
    expect(laterInterceptor).not.toHaveBeenCalled();
    expect(harness.handlerEffect).not.toHaveBeenCalled();
    expect(harness.recorderEffect).not.toHaveBeenCalled();
    expect(harness.repositoryEffect).not.toHaveBeenCalled();
    expect(harness.llmEffect).not.toHaveBeenCalled();
  });

  it("rejects an inverted scheduled-memory window before dispatch", async () => {
    const eventsModule = await import("./events.js").catch(() => ({
      memoryScheduleTickEvent: undefined,
    }));
    expect(eventsModule.memoryScheduleTickEvent).toBeDefined();
    if (eventsModule.memoryScheduleTickEvent === undefined) {
      throw new Error("memoryScheduleTickEvent is unavailable");
    }

    const harness = createBoundaryHarness();
    const handler = vi.fn();
    harness.eventBus.subscribe("memory.schedule.tick", handler, {
      mode: "observe",
    });
    const invertedEvent = {
      id: "memory-schedule-inverted",
      type: "memory.schedule.tick",
      source: "test",
      occurredAt: NOW,
      traceId: "trace-memory-inverted",
      payload: {
        from: "2026-07-23T13:00:00.000Z",
        to: "2026-07-23T12:00:00.000Z",
      },
      metadata: {},
    } as EventEnvelope<"memory.schedule.tick", { from: string; to: string }>;

    const caught = await dispatch({
      definition: eventsModule.memoryScheduleTickEvent,
      event: invertedEvent,
      eventBus: harness.eventBus,
      engine: harness.engine,
      workflow: harness.workflow,
      context: {
        ...harness.context,
        traceId: invertedEvent.traceId,
      },
    }).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      name: "EventValidationError",
      eventType: "memory.schedule.tick",
      phase: "payload",
      cause: expect.anything(),
    });
    expect(String((caught as { cause: unknown }).cause)).toContain(
      "from must be before or equal to to",
    );
    expect(handler).not.toHaveBeenCalled();
    expect(harness.recorderEffect).not.toHaveBeenCalled();
    expect(harness.repositoryEffect).not.toHaveBeenCalled();
    expect(harness.llmEffect).not.toHaveBeenCalled();
  });
});
