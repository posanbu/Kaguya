import { WorkflowEngine } from "@kaguya/engine";
import { memoryOutputSchema, type MemoryOutput } from "@kaguya/llm/schemas";
import {
  type CompiledPrompt,
  type MemoryRecord,
  type MessageRecord,
  type PromptFragment,
} from "@kaguya/schema";
import {
  defineNode,
  defineWorkflow,
  type WorkflowDefinition,
} from "@kaguya/sdk";

import { dispatchEvent } from "../dispatch.js";
import {
  memoryScheduleTickEvent,
  memorySessionTickEvent,
  memoryWriteRequestedEvent,
  memoryWrittenEvent,
} from "../events.js";
import { getDatabase, getEventBus, getLlmClient } from "../services.js";
import {
  MODEL_ID,
  assertOrigin,
  compileAndPublish,
  emitNodeEvent,
  historyFragment,
  promptFragment,
  requiredSessionId,
} from "./shared.js";

export type MemoryScheduleEvent = ReturnType<
  typeof memoryScheduleTickEvent.create
>;

type MemorySessionEvent = ReturnType<typeof memorySessionTickEvent.create>;

interface MemoryWindowContext {
  messages: MessageRecord[];
  window: { from: string; to: string };
}

const loadWindowNode = defineNode<MemorySessionEvent, MemoryWindowContext>({
  id: "load-window",
  async run(event, context) {
    assertOrigin(event, memorySessionTickEvent, context);
    const window = memorySessionTickEvent.payloadSchema.parse(event.payload);
    return {
      messages: getDatabase(context).messages.listWindow(
        requiredSessionId(context),
        window.from,
        window.to,
      ),
      window,
    };
  },
});

const compileMemoryNode = defineNode<MemoryWindowContext, CompiledPrompt>({
  id: "compile-memory",
  async run(input, context) {
    return compileAndPublish(
      "memory",
      memoryFragments(input),
      "compile-memory",
      context,
    );
  },
});

const extractMemoryNode = defineNode<CompiledPrompt, MemoryOutput>({
  id: "extract-memory",
  async run(prompt, context) {
    return memoryOutputSchema.parse(
      await getLlmClient(context).generate(
        {
          kind: "memory",
          modelId: MODEL_ID,
          prompt,
          traceId: context.traceId,
          workflowId: "memory-session-workflow",
          nodeId: "extract-memory",
        },
        context,
      ),
    );
  },
});

const writeMemoryNode = defineNode<MemoryOutput, MemoryRecord[]>({
  id: "write-memory",
  async run(output, context) {
    const extracted = memoryOutputSchema.parse(output);
    const database = getDatabase(context);
    const sessionId = requiredSessionId(context);
    const records: MemoryRecord[] = [];
    for (const content of extracted.memories) {
      const record: MemoryRecord = {
        id: context.nextId("memory"),
        sessionId,
        content,
        occurredAt: context.now().toISOString(),
        metadata: {
          kind: "long-term",
          parentTraceId: context.traceId,
          traceId: context.traceId,
        },
      };
      await emitNodeEvent(context, memoryWriteRequestedEvent, "write-memory", {
        memoryId: record.id,
        kind: "long-term",
        content: record.content,
      });
      database.memories.insert(record);
      records.push(record);
      await emitNodeEvent(context, memoryWrittenEvent, "write-memory", {
        memoryId: record.id,
        kind: "long-term",
      });
    }
    return records;
  },
});

const expandSessionsNode = defineNode<
  MemoryScheduleEvent,
  { sessionIds: string[] }
>({
  id: "expand-sessions",
  async run(event, context) {
    assertOrigin(event, memoryScheduleTickEvent, context);
    const window = memoryScheduleTickEvent.payloadSchema.parse(event.payload);
    const database = getDatabase(context);
    const sessionIds = database.messages.listSessionIds(window.from, window.to);
    const workflow = createMemorySessionWorkflow();
    const engine = new WorkflowEngine({ recorder: database.eventRuns });

    for (const sessionId of sessionIds) {
      const derivedEvent: MemorySessionEvent = memorySessionTickEvent.create(
        {
          id: context.nextId("memory-session-event"),
          source: "memory-workflow/expand-sessions",
          occurredAt: context.now().toISOString(),
          traceId: context.traceId,
          sessionId,
          metadata: {
            ...event.metadata,
            parentEventId: event.id,
            parentTraceId: context.traceId,
          },
        },
        window,
      );
      await dispatchEvent({
        definition: memorySessionTickEvent,
        event: derivedEvent,
        eventBus: getEventBus(context),
        engine,
        workflow,
        context: {
          ...context,
          traceId: context.traceId,
          sessionId,
        },
      });
    }

    return { sessionIds };
  },
});

export function createMemoryWorkflow(): WorkflowDefinition {
  return defineWorkflow({
    id: "memory-workflow",
    nodes: [expandSessionsNode],
    edges: [],
  });
}

function createMemorySessionWorkflow(): WorkflowDefinition {
  return defineWorkflow({
    id: "memory-session-workflow",
    nodes: [
      loadWindowNode,
      compileMemoryNode,
      extractMemoryNode,
      writeMemoryNode,
    ],
    edges: [
      { from: "load-window", to: "compile-memory" },
      { from: "compile-memory", to: "extract-memory" },
      { from: "extract-memory", to: "write-memory" },
    ],
  });
}

function memoryFragments(input: MemoryWindowContext): PromptFragment[] {
  return [
    historyFragment("memory-history", input.messages, {
      from: input.window.from,
      to: input.window.to,
    }),
    promptFragment(
      "memory-policy",
      "policy",
      40,
      "Extract durable facts worth remembering from this exact time window.",
      { scope: "memory" },
    ),
  ];
}
