import { KaguyaDatabase } from "@kaguya/database";
import { EventBus, WorkflowEngine } from "@kaguya/engine";
import { KaguyaLlmClient } from "@kaguya/llm/client";
import { createDeterministicModel } from "@kaguya/llm/testing";
import type {
  PlatformDeliveryReceipt,
  PlatformMessageTarget,
  PlatformReplySender,
} from "@kaguya/platform-adapters";
import { PromptCompiler } from "@kaguya/prompt";
import type { EventEnvelope, MessageRecord } from "@kaguya/schema";
import type { WorkflowContext } from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import { dispatchEvent } from "./dispatch.js";
import { approvedEventDefinitions, messageReceivedEvent } from "./events.js";
import { LlmLifecycleClient } from "./llm-lifecycle.js";
import type { WorkflowServices } from "./services.js";
import {
  createHeartbeatWorkflow,
  createMemoryWorkflow,
  createMessageWorkflow,
} from "./workflows.js";

const NOW = "2026-07-23T12:00:00.000Z";

function createHarness(outputs: readonly unknown[]) {
  const database = KaguyaDatabase.open(":memory:");
  database.migrate();
  const eventBus = new EventBus();
  let sequence = 0;
  let elapsedMs = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;
  const now = () => new Date(Date.parse(NOW) + elapsedMs++);
  const llmClient = new LlmLifecycleClient(
    new KaguyaLlmClient({
      model: createDeterministicModel(outputs),
      traceWriter: database.llmTraces,
      now,
      nextId,
    }),
    eventBus,
  );
  const services: WorkflowServices = {
    database,
    promptCompiler: new PromptCompiler(),
    llmClient,
    eventBus,
  };
  const engine = new WorkflowEngine({ recorder: database.eventRuns });

  return {
    database,
    engine,
    eventBus,
    contextServices: services,
    context(event: EventEnvelope): WorkflowContext {
      services.messageReceivedEvent = event;
      return {
        traceId: event.traceId,
        ...(event.sessionId === undefined
          ? {}
          : { sessionId: event.sessionId }),
        now,
        nextId,
        services,
      };
    },
  };
}

async function runMessageWorkflowForTest(options: {
  eventMetadata?: Record<string, unknown>;
  services?: Partial<WorkflowServices>;
}) {
  const harness = createHarness([
    { shouldReply: true, reason: "direct question" },
    { text: "It is a lovely night for watching the moon." },
  ]);
  Object.assign(harness.contextServices, options.services ?? {});
  const event = messageReceivedEvent.create(
    {
      id: "message-platform-send",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-message-platform-send",
      sessionId: "session-message-platform-send",
      metadata: options.eventMetadata ?? {},
    },
    { text: "How is the moon?" },
  );
  harness.contextServices.messageReceivedEvent = event;
  try {
    return await dispatchEvent({
      definition: messageReceivedEvent,
      event,
      eventBus: harness.eventBus,
      engine: harness.engine,
      workflow: createMessageWorkflow(),
      context: harness.context(event),
    });
  } finally {
    harness.database.close();
  }
}

function message(
  id: string,
  sessionId: string,
  content: string,
  occurredAt: string,
): MessageRecord {
  return {
    id,
    sessionId,
    role: "user",
    content,
    occurredAt,
    metadata: { traceId: `seed-${id}` },
  };
}

function observeApprovedLifecycle(eventBus: EventBus): string[] {
  const eventTypes: string[] = [];
  for (const definition of approvedEventDefinitions) {
    eventBus.subscribe(
      definition.type,
      (event) => {
        eventTypes.push(event.type);
      },
      { mode: "observe" },
    );
  }
  return eventTypes;
}

describe("message workflow", () => {
  it("sends persisted assistant replies through the configured platform sender", async () => {
    const sent: Array<{ target: PlatformMessageTarget; text: string }> = [];
    const platformReplySender: PlatformReplySender = {
      async sendTextReply(target, text): Promise<PlatformDeliveryReceipt> {
        sent.push({ target, text });
        return {
          ok: true,
          adapterId: "napcat.qq.main",
          platform: "qq",
          target,
          platformMessageId: "sent-1",
        };
      },
    };

    const result = await runMessageWorkflowForTest({
      eventMetadata: {
        target: { kind: "private", userId: "112233" },
      },
      services: { platformReplySender },
    });

    expect(sent).toEqual([
      {
        target: { kind: "private", userId: "112233" },
        text: "It is a lovely night for watching the moon.",
      },
    ]);
    expect(result?.outputs["send-reply"]).toMatchObject({
      ok: true,
      platformMessageId: "sent-1",
    });
  });

  it("rejects malformed envelopes before writing a message or LLM trace", async () => {
    const harness = createHarness([{ shouldReply: false }]);
    const sessionId = "session-malformed-message";
    const event: EventEnvelope<"message.received", { text: string }> = {
      id: "malformed-message-event",
      type: "message.received",
      source: "integration-test",
      occurredAt: "not-an-iso-datetime",
      traceId: "trace-malformed-message",
      sessionId,
      payload: { text: "This must not be persisted." },
      metadata: {},
    };

    try {
      await expect(
        harness.engine.run(
          createMessageWorkflow(),
          event,
          harness.context(event),
        ),
      ).rejects.toThrow();
      expect(harness.database.messages.listRecent(sessionId, 10)).toEqual([]);
      expect(harness.database.memories.listRecent(sessionId, 10)).toEqual([]);
      expect(harness.database.llmTraces.listByTrace(event.traceId)).toEqual([]);
    } finally {
      harness.database.close();
    }
  });

  it("persists both messages and records route and reply prompts on one trace", async () => {
    const harness = createHarness([
      { shouldReply: true, reason: "direct question" },
      { text: "The moon is bright tonight." },
    ]);
    const sessionId = "session-message";
    const event: EventEnvelope<"message.received", { text: string }> = {
      id: "message-event-1",
      type: "message.received",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-message",
      sessionId,
      payload: { text: "How is the moon?" },
      metadata: { channel: "test" },
    };

    try {
      const result = await harness.engine.run(
        createMessageWorkflow(),
        event,
        harness.context(event),
      );

      expect(result.completedNodeIds).toEqual([
        "persist-message",
        "load-context",
        "compile-route",
        "decide-route",
        "compile-reply",
        "generate-reply",
        "persist-reply",
        "prepare-send-reply",
        "send-reply",
      ]);
      const messages = harness.database.messages
        .listRecent(sessionId, 10)
        .reverse();
      expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "How is the moon?" },
        { role: "assistant", content: "The moon is bright tonight." },
      ]);
      expect(
        messages.every((record) => record.metadata.traceId === event.traceId),
      ).toBe(true);

      const traces = harness.database.llmTraces.listByTrace(event.traceId);
      expect(traces.map((trace) => trace.kind)).toEqual(["route", "reply"]);
      expect(
        traces
          .find((trace) => trace.kind === "route")
          ?.prompt.fragments.map((fragment) => fragment.source),
      ).toEqual(
        expect.arrayContaining(["persona", "history", "memory", "policy"]),
      );
      expect(
        traces
          .find((trace) => trace.kind === "reply")
          ?.prompt.fragments.some(
            (fragment) => fragment.metadata.scope === "route",
          ),
      ).toBe(false);
      expect(traces.every((trace) => trace.traceId === event.traceId)).toBe(
        true,
      );
      expect(
        harness.database.eventRuns
          .listByTrace(event.traceId)
          .every((run) => run.traceId === event.traceId),
      ).toBe(true);
    } finally {
      harness.database.close();
    }
  });

  it("emits the real approved lifecycle sequence on success", async () => {
    const harness = createHarness([
      { shouldReply: true, reason: "direct question" },
      { text: "The moon is bright tonight." },
    ]);
    const lifecycle = observeApprovedLifecycle(harness.eventBus);
    const event = messageReceivedEvent.create(
      {
        id: "message-lifecycle-success",
        source: "integration-test",
        occurredAt: NOW,
        traceId: "trace-message-lifecycle-success",
        sessionId: "session-message-lifecycle-success",
        metadata: {},
      },
      { text: "How is the moon?" },
    );

    try {
      await dispatchEvent({
        definition: messageReceivedEvent,
        event,
        eventBus: harness.eventBus,
        engine: harness.engine,
        workflow: createMessageWorkflow(),
        context: harness.context(event),
      });

      expect(lifecycle).toEqual([
        "message.received",
        "message.persisted",
        "prompt.compiled",
        "route.requested",
        "llm.requested",
        "llm.completed",
        "route.decided",
        "prompt.compiled",
        "llm.requested",
        "llm.completed",
        "reply.generated",
        "message.persisted",
      ]);
    } finally {
      harness.database.close();
    }
  });

  it("emits the real approved lifecycle sequence on LLM failure", async () => {
    const harness = createHarness([{ shouldReply: "not-a-boolean" }]);
    const lifecycle = observeApprovedLifecycle(harness.eventBus);
    const event = messageReceivedEvent.create(
      {
        id: "message-lifecycle-failure",
        source: "integration-test",
        occurredAt: NOW,
        traceId: "trace-message-lifecycle-failure",
        sessionId: "session-message-lifecycle-failure",
        metadata: {},
      },
      { text: "How is the moon?" },
    );

    try {
      await expect(
        dispatchEvent({
          definition: messageReceivedEvent,
          event,
          eventBus: harness.eventBus,
          engine: harness.engine,
          workflow: createMessageWorkflow(),
          context: harness.context(event),
        }),
      ).rejects.toMatchObject({
        name: "KaguyaLlmError",
        kind: "non-retryable",
      });

      expect(lifecycle).toEqual([
        "message.received",
        "message.persisted",
        "prompt.compiled",
        "route.requested",
        "llm.requested",
        "llm.failed",
      ]);
      expect(
        harness.database.eventRuns.listByTrace(event.traceId).at(-1),
      ).toMatchObject({
        status: "failed",
        retryable: false,
        error: { name: "KaguyaLlmError" },
      });
    } finally {
      harness.database.close();
    }
  });

  it("cannot persist a blank generated assistant message", async () => {
    const harness = createHarness([
      { shouldReply: true, reason: "direct question" },
      { text: "   " },
    ]);
    const sessionId = "session-message-blank-reply";
    const event = messageReceivedEvent.create(
      {
        id: "message-blank-reply",
        source: "integration-test",
        occurredAt: NOW,
        traceId: "trace-message-blank-reply",
        sessionId,
        metadata: {},
      },
      { text: "Please answer." },
    );

    try {
      await expect(
        dispatchEvent({
          definition: messageReceivedEvent,
          event,
          eventBus: harness.eventBus,
          engine: harness.engine,
          workflow: createMessageWorkflow(),
          context: harness.context(event),
        }),
      ).rejects.toMatchObject({
        name: "KaguyaLlmError",
        kind: "non-retryable",
      });
      expect(
        harness.database.messages
          .listRecent(sessionId, 10)
          .map(({ role, content }) => ({ role, content })),
      ).toEqual([{ role: "user", content: "Please answer." }]);
    } finally {
      harness.database.close();
    }
  });
});

describe("heartbeat workflow", () => {
  it("rejects malformed envelopes before writing state or LLM traces", async () => {
    const harness = createHarness([
      {
        mood: "calm",
        relationship: "unknown",
        shortTermMemories: [],
      },
      { shouldReply: false },
    ]);
    const sessionId = "session-malformed-heartbeat";
    const event: EventEnvelope<"heartbeat.tick", Record<string, never>> = {
      id: "malformed-heartbeat-event",
      type: "heartbeat.tick",
      source: "",
      occurredAt: NOW,
      traceId: "trace-malformed-heartbeat",
      sessionId,
      payload: {},
      metadata: {},
    };

    try {
      await expect(
        harness.engine.run(
          createHeartbeatWorkflow(),
          event,
          harness.context(event),
        ),
      ).rejects.toThrow();
      expect(harness.database.messages.listRecent(sessionId, 10)).toEqual([]);
      expect(harness.database.memories.listRecent(sessionId, 10)).toEqual([]);
      expect(harness.database.llmTraces.listByTrace(event.traceId)).toEqual([]);
    } finally {
      harness.database.close();
    }
  });

  it("rejects a non-heartbeat event at the workflow boundary", async () => {
    const harness = createHarness([
      {
        mood: "calm",
        relationship: "unknown",
        shortTermMemories: [],
      },
      { shouldReply: false },
    ]);
    const event: EventEnvelope<"message.received", { text: string }> = {
      id: "wrong-heartbeat-event",
      type: "message.received",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-wrong-heartbeat",
      sessionId: "session-wrong-heartbeat",
      payload: { text: "not a heartbeat" },
      metadata: {},
    };

    try {
      await expect(
        harness.engine.run(
          createHeartbeatWorkflow(),
          event,
          harness.context(event),
        ),
      ).rejects.toThrow("expected heartbeat.tick");
    } finally {
      harness.database.close();
    }
  });

  it("rejects unexpected heartbeat payload fields", async () => {
    const harness = createHarness([
      {
        mood: "calm",
        relationship: "unknown",
        shortTermMemories: [],
      },
      { shouldReply: false },
    ]);
    const event: EventEnvelope<"heartbeat.tick", Record<string, unknown>> = {
      id: "invalid-heartbeat-event",
      type: "heartbeat.tick",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-invalid-heartbeat",
      sessionId: "session-invalid-heartbeat",
      payload: { unexpected: true },
      metadata: {},
    };

    try {
      await expect(
        harness.engine.run(
          createHeartbeatWorkflow(),
          event,
          harness.context(event),
        ),
      ).rejects.toThrow(/unrecognized key/i);
    } finally {
      harness.database.close();
    }
  });

  it("persists state without short-term memories and renders it on the next heartbeat", async () => {
    const harness = createHarness([
      {
        mood: "reflective",
        relationship: "new",
        shortTermMemories: [],
      },
      { shouldReply: false },
      {
        mood: "hopeful",
        relationship: "growing",
        shortTermMemories: [],
      },
      { shouldReply: false },
    ]);
    const sessionId = "session-state";
    const firstEvent: EventEnvelope<"heartbeat.tick", Record<string, never>> = {
      id: "heartbeat-state-1",
      type: "heartbeat.tick",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-state-1",
      sessionId,
      payload: {},
      metadata: {},
    };
    const secondEvent: EventEnvelope<
      "heartbeat.tick",
      Record<string, never>
    > = {
      ...firstEvent,
      id: "heartbeat-state-2",
      traceId: "trace-state-2",
    };

    try {
      await harness.engine.run(
        createHeartbeatWorkflow(),
        firstEvent,
        harness.context(firstEvent),
      );

      const firstState = harness.database.memories
        .listRecent(sessionId, 10)
        .find((record) => record.metadata.kind === "state");
      expect(firstState).toMatchObject({
        content: "Mood: reflective\nRelationship: new",
        metadata: {
          kind: "state",
          mood: "reflective",
          relationship: "new",
          traceId: firstEvent.traceId,
        },
      });

      await harness.engine.run(
        createHeartbeatWorkflow(),
        secondEvent,
        harness.context(secondEvent),
      );

      const secondStatePrompt = harness.database.llmTraces
        .listByTrace(secondEvent.traceId)
        .find((trace) => trace.kind === "state")?.prompt.text;
      expect(secondStatePrompt).toContain("Mood: reflective");
      expect(secondStatePrompt).toContain("Relationship: new");
      expect(
        harness.database.memories
          .listRecent(sessionId, 10)
          .filter((record) => record.metadata.kind === "state"),
      ).toHaveLength(2);
    } finally {
      harness.database.close();
    }
  });

  it("writes state memories and skips reply generation when routing says no", async () => {
    const harness = createHarness([
      {
        mood: "calm",
        relationship: "trusted",
        shortTermMemories: ["The user enjoys astronomy.", "Follow up gently."],
      },
      { shouldReply: false, reason: "no proactive message needed" },
    ]);
    const sessionId = "session-heartbeat";
    const event: EventEnvelope<"heartbeat.tick", Record<string, never>> = {
      id: "heartbeat-event-1",
      type: "heartbeat.tick",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-heartbeat",
      sessionId,
      payload: {},
      metadata: {},
    };
    harness.database.messages.insert(
      message(
        "seed-heartbeat",
        sessionId,
        "I enjoy astronomy.",
        "2026-07-23T11:59:00.000Z",
      ),
    );

    try {
      const result = await harness.engine.run(
        createHeartbeatWorkflow(),
        event,
        harness.context(event),
      );

      expect(result.completedNodeIds).toEqual([
        "load-context",
        "compile-state",
        "update-state",
        "compile-route",
        "decide-route",
      ]);
      const memories = harness.database.memories.listRecent(sessionId, 10);
      expect(
        memories
          .filter((record) => record.metadata.kind === "short-term")
          .map((record) => record.content)
          .sort(),
      ).toEqual(["Follow up gently.", "The user enjoys astronomy."]);
      expect(
        memories.every((record) => record.metadata.traceId === event.traceId),
      ).toBe(true);
      expect(harness.database.messages.listRecent(sessionId, 10)).toHaveLength(
        1,
      );

      const traces = harness.database.llmTraces.listByTrace(event.traceId);
      expect(traces.map((trace) => trace.kind)).toEqual(["state", "route"]);
      expect(
        traces
          .find((trace) => trace.kind === "state")
          ?.prompt.fragments.some(
            (fragment) =>
              fragment.source === "policy" &&
              fragment.metadata.scope === "state",
          ),
      ).toBe(true);
      expect(traces.every((trace) => trace.traceId === event.traceId)).toBe(
        true,
      );
      expect(
        harness.database.eventRuns
          .listByTrace(event.traceId)
          .every((run) => run.traceId === event.traceId),
      ).toBe(true);
    } finally {
      harness.database.close();
    }
  });

  it("attributes a proactive reply trace to the heartbeat workflow", async () => {
    const harness = createHarness([
      {
        mood: "cheerful",
        relationship: "friendly",
        shortTermMemories: [],
      },
      { shouldReply: true, reason: "a gentle check-in is useful" },
      { text: "How has your afternoon been?" },
    ]);
    const event: EventEnvelope<"heartbeat.tick", Record<string, never>> = {
      id: "heartbeat-event-2",
      type: "heartbeat.tick",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-heartbeat-reply",
      sessionId: "session-heartbeat-reply",
      payload: {},
      metadata: {},
    };

    try {
      await harness.engine.run(
        createHeartbeatWorkflow(),
        event,
        harness.context(event),
      );

      const replyTrace = harness.database.llmTraces
        .listByTrace(event.traceId)
        .find((trace) => trace.kind === "reply");
      expect(replyTrace?.workflowId).toBe("heartbeat-workflow");
    } finally {
      harness.database.close();
    }
  });
});

describe("scheduled memory workflow", () => {
  it("rejects malformed global envelopes before fan-out writes or LLM traces", async () => {
    const harness = createHarness([{ memories: ["must not be written"] }]);
    const event: EventEnvelope<
      "memory.schedule.tick",
      { from: string; to: string }
    > = {
      id: "",
      type: "memory.schedule.tick",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-malformed-memory",
      payload: {
        from: "2026-07-23T10:00:00.000Z",
        to: "2026-07-23T11:00:00.000Z",
      },
      metadata: {},
    };
    const seed = message(
      "malformed-memory-seed",
      "session-malformed-memory",
      "This seed must remain untouched.",
      "2026-07-23T10:30:00.000Z",
    );
    harness.database.messages.insert(seed);

    try {
      await expect(
        harness.engine.run(
          createMemoryWorkflow(),
          event,
          harness.context(event),
        ),
      ).rejects.toThrow();
      expect(harness.database.messages.listRecent(seed.sessionId, 10)).toEqual([
        seed,
      ]);
      expect(harness.database.memories.listRecent(seed.sessionId, 10)).toEqual(
        [],
      );
      expect(harness.database.llmTraces.listByTrace(event.traceId)).toEqual([]);
    } finally {
      harness.database.close();
    }
  });

  it("validates each derived session envelope before session workflow writes", async () => {
    const harness = createHarness([{ memories: ["must not be written"] }]);
    const event: EventEnvelope<
      "memory.schedule.tick",
      { from: string; to: string }
    > = {
      id: "memory-event-malformed-child",
      type: "memory.schedule.tick",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-malformed-memory-child",
      payload: {
        from: "2026-07-23T10:00:00.000Z",
        to: "2026-07-23T11:00:00.000Z",
      },
      metadata: {},
    };
    const seed = message(
      "malformed-memory-child-seed",
      "session-malformed-memory-child",
      "This seed causes fan-out.",
      "2026-07-23T10:30:00.000Z",
    );
    harness.database.messages.insert(seed);
    harness.eventBus.subscribe("memory.session.tick", (derivedEvent) => ({
      continue: true,
      event: { ...derivedEvent, source: "" },
    }));

    try {
      await expect(
        harness.engine.run(
          createMemoryWorkflow(),
          event,
          harness.context(event),
        ),
      ).rejects.toThrow();
      expect(harness.database.memories.listRecent(seed.sessionId, 10)).toEqual(
        [],
      );
      expect(harness.database.llmTraces.listByTrace(event.traceId)).toEqual([]);
    } finally {
      harness.database.close();
    }
  });

  it("rejects a rewritten derived-session identity before child workflow effects", async () => {
    const harness = createHarness([{ memories: ["must not be written"] }]);
    const event: EventEnvelope<
      "memory.schedule.tick",
      { from: string; to: string }
    > = {
      id: "memory-event-rewritten-child-identity",
      type: "memory.schedule.tick",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-rewritten-memory-child",
      payload: {
        from: "2026-07-23T10:00:00.000Z",
        to: "2026-07-23T11:00:00.000Z",
      },
      metadata: {},
    };
    const seed = message(
      "rewritten-memory-child-seed",
      "session-rewritten-memory-child",
      "This seed causes fan-out.",
      "2026-07-23T10:30:00.000Z",
    );
    harness.database.messages.insert(seed);
    const derivedObserver = vi.fn();
    harness.eventBus.subscribe(
      "memory.session.tick",
      (derivedEvent) => ({
        continue: true,
        event: { ...derivedEvent, sessionId: "session-other" },
      }),
      { priority: 10, mode: "intercept" },
    );
    harness.eventBus.subscribe("memory.session.tick", derivedObserver, {
      mode: "observe",
    });

    try {
      await expect(
        harness.engine.run(
          createMemoryWorkflow(),
          event,
          harness.context(event),
        ),
      ).rejects.toMatchObject({
        name: "EventValidationError",
        eventType: "memory.session.tick",
        phase: "definition",
      });
      expect(derivedObserver).not.toHaveBeenCalled();
      expect(harness.database.memories.listRecent(seed.sessionId, 10)).toEqual(
        [],
      );
      expect(harness.database.llmTraces.listByTrace(event.traceId)).toEqual([]);
      expect(
        harness.database.eventRuns
          .listByTrace(event.traceId)
          .filter((run) => run.workflowId === "memory-session-workflow"),
      ).toEqual([]);
    } finally {
      harness.database.close();
    }
  });

  it("fans out only sessions in the requested window and preserves the parent trace", async () => {
    const harness = createHarness([
      { memories: ["Session A likes moonlit walks."] },
      { memories: ["Session B asked about constellations."] },
    ]);
    const event: EventEnvelope<
      "memory.schedule.tick",
      { from: string; to: string }
    > = {
      id: "memory-event-1",
      type: "memory.schedule.tick",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-memory",
      payload: {
        from: "2026-07-23T10:00:00.000Z",
        to: "2026-07-23T11:00:00.000Z",
      },
      metadata: { schedule: "daily" },
    };
    for (const record of [
      message(
        "a-before",
        "session-a",
        "outside before",
        "2026-07-23T09:59:59.999Z",
      ),
      message(
        "a-inside",
        "session-a",
        "moonlit walks",
        "2026-07-23T10:30:00.000Z",
      ),
      message(
        "a-after",
        "session-a",
        "outside after",
        "2026-07-23T11:00:00.001Z",
      ),
      message(
        "b-inside",
        "session-b",
        "constellations",
        "2026-07-23T10:45:00.000Z",
      ),
      message(
        "c-outside",
        "session-c",
        "outside session",
        "2026-07-23T12:00:00.000Z",
      ),
    ]) {
      harness.database.messages.insert(record);
    }
    const derivedEvents: EventEnvelope[] = [];
    harness.eventBus.subscribe(
      "memory.session.tick",
      (derivedEvent) => {
        derivedEvents.push(derivedEvent);
      },
      { mode: "observe" },
    );

    try {
      await harness.engine.run(
        createMemoryWorkflow(),
        event,
        harness.context(event),
      );

      expect(
        harness.database.memories
          .listRecent("session-a", 10)
          .map((record) => record.content),
      ).toEqual(["Session A likes moonlit walks."]);
      expect(
        harness.database.memories
          .listRecent("session-b", 10)
          .map((record) => record.content),
      ).toEqual(["Session B asked about constellations."]);
      expect(harness.database.memories.listRecent("session-c", 10)).toEqual([]);

      const memories = [
        ...harness.database.memories.listRecent("session-a", 10),
        ...harness.database.memories.listRecent("session-b", 10),
      ];
      expect(
        memories.every((record) => record.metadata.traceId === event.traceId),
      ).toBe(true);

      const traces = harness.database.llmTraces.listByTrace(event.traceId);
      expect(traces.map((trace) => trace.kind)).toEqual(["memory", "memory"]);
      const compiledText = traces.map((trace) => trace.prompt.text).join("\n");
      expect(compiledText).toContain("moonlit walks");
      expect(compiledText).toContain("constellations");
      expect(compiledText).not.toContain("outside before");
      expect(compiledText).not.toContain("outside after");
      expect(compiledText).not.toContain("outside session");
      expect(
        traces.every(
          (trace) =>
            trace.traceId === event.traceId &&
            trace.prompt.fragments.some(
              (fragment) =>
                fragment.source === "policy" &&
                fragment.metadata.scope === "memory",
            ),
        ),
      ).toBe(true);

      expect(derivedEvents).toHaveLength(2);
      expect(derivedEvents.map((derived) => derived.sessionId)).toEqual([
        "session-a",
        "session-b",
      ]);
      expect(
        derivedEvents.every(
          (derived) =>
            derived.traceId === event.traceId &&
            derived.metadata.parentTraceId === event.traceId &&
            derived.metadata.parentEventId === event.id,
        ),
      ).toBe(true);

      const runs = harness.database.eventRuns.listByTrace(event.traceId);
      expect(runs.every((run) => run.traceId === event.traceId)).toBe(true);
      expect(
        runs.filter(
          (run) =>
            run.workflowId === "memory-session-workflow" &&
            run.nodeId === "load-window",
        ),
      ).toHaveLength(2);
    } finally {
      harness.database.close();
    }
  });

  it("cannot persist a blank generated long-term memory", async () => {
    const harness = createHarness([{ memories: [" \n "] }]);
    const sessionId = "session-blank-memory";
    harness.database.messages.insert(
      message(
        "blank-memory-seed",
        sessionId,
        "Remember this.",
        "2026-07-23T10:30:00.000Z",
      ),
    );
    const eventsModule = await import("./events.js");
    const event = eventsModule.memoryScheduleTickEvent.create(
      {
        id: "memory-event-blank-output",
        source: "integration-test",
        occurredAt: NOW,
        traceId: "trace-memory-blank-output",
        metadata: {},
      },
      {
        from: "2026-07-23T10:00:00.000Z",
        to: "2026-07-23T11:00:00.000Z",
      },
    );

    try {
      await expect(
        dispatchEvent({
          definition: eventsModule.memoryScheduleTickEvent,
          event,
          eventBus: harness.eventBus,
          engine: harness.engine,
          workflow: createMemoryWorkflow(),
          context: harness.context(event),
        }),
      ).rejects.toMatchObject({
        name: "KaguyaLlmError",
        kind: "non-retryable",
      });
      expect(harness.database.memories.listRecent(sessionId, 10)).toEqual([]);
    } finally {
      harness.database.close();
    }
  });
});
