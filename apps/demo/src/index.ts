import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { KaguyaDatabase } from "@kaguya/database";
import { EventBus, WorkflowEngine } from "@kaguya/engine";
import { KaguyaLlmClient, createDeterministicModel } from "@kaguya/llm";
import { PromptCompiler } from "@kaguya/prompt";

import { dispatchEvent } from "./dispatch.js";
import {
  heartbeatTickEvent,
  memoryScheduleTickEvent,
  messageReceivedEvent,
} from "./events.js";
import { LlmLifecycleClient } from "./llm-lifecycle.js";
import type { WorkflowServices } from "./services.js";
import {
  createHeartbeatWorkflow,
  createMemoryWorkflow,
  createMessageWorkflow,
} from "./workflows.js";

const DEMO_TIME = "2026-07-23T12:00:00.000Z";
const DEMO_SESSION_ID = "demo-session";
const DEMO_TRACE_IDS = {
  message: "demo-message-trace",
  heartbeat: "demo-heartbeat-trace",
  memory: "demo-memory-trace",
} as const;
const databasePath = fileURLToPath(
  new URL("../../../.data/kaguya-demo.sqlite", import.meta.url),
);

async function main(): Promise<void> {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = KaguyaDatabase.open(databasePath);

  try {
    database.migrate();
    cleanupDemoRecords(database);
    let sequence = 0;
    let elapsedMs = 0;
    const nextId = (prefix: string) =>
      `${prefix}-${String(++sequence).padStart(4, "0")}`;
    const now = () => new Date(Date.parse(DEMO_TIME) + elapsedMs++);
    const eventBus = new EventBus();
    const services: WorkflowServices = {
      database,
      promptCompiler: new PromptCompiler(),
      llmClient: new LlmLifecycleClient(
        new KaguyaLlmClient({
          model: createDeterministicModel([
            { shouldReply: true, reason: "the user asked a question" },
            { text: "It is a lovely night for watching the moon." },
            {
              mood: "calm",
              relationship: "friendly",
              shortTermMemories: ["The user enjoys talking about the moon."],
            },
            { shouldReply: false, reason: "no proactive reply is needed" },
            { memories: ["The user enjoys talking about the moon."] },
          ]),
          traceWriter: database.llmTraces,
          now,
          nextId,
        }),
        eventBus,
      ),
      eventBus,
    };
    const engine = new WorkflowEngine({ recorder: database.eventRuns });

    const messageEvent = messageReceivedEvent.create(
      {
        id: "demo-message-event",
        source: "demo",
        occurredAt: DEMO_TIME,
        traceId: DEMO_TRACE_IDS.message,
        sessionId: DEMO_SESSION_ID,
        metadata: { demo: true },
      },
      { text: "Is tonight good for watching the moon?" },
    );
    const heartbeatEvent = heartbeatTickEvent.create(
      {
        id: "demo-heartbeat-event",
        source: "demo",
        occurredAt: DEMO_TIME,
        traceId: DEMO_TRACE_IDS.heartbeat,
        sessionId: DEMO_SESSION_ID,
        metadata: { demo: true },
      },
      {},
    );
    const memoryEvent = memoryScheduleTickEvent.create(
      {
        id: "demo-memory-event",
        source: "demo",
        occurredAt: DEMO_TIME,
        traceId: DEMO_TRACE_IDS.memory,
        metadata: { demo: true },
      },
      {
        from: "2026-07-23T00:00:00.000Z",
        to: "2026-07-23T23:59:59.999Z",
      },
    );

    await dispatchEvent({
      definition: messageReceivedEvent,
      event: messageEvent,
      eventBus,
      engine,
      workflow: createMessageWorkflow(),
      context: workflowContext(messageEvent, services, now, nextId),
    });
    await dispatchEvent({
      definition: heartbeatTickEvent,
      event: heartbeatEvent,
      eventBus,
      engine,
      workflow: createHeartbeatWorkflow(),
      context: workflowContext(heartbeatEvent, services, now, nextId),
    });
    await dispatchEvent({
      definition: memoryScheduleTickEvent,
      event: memoryEvent,
      eventBus,
      engine,
      workflow: createMemoryWorkflow(),
      context: workflowContext(memoryEvent, services, now, nextId),
    });

    const messageCount = database.messages.listRecent(
      DEMO_SESSION_ID,
      100,
    ).length;
    const memoryCount = database.memories.listRecent(
      DEMO_SESSION_ID,
      100,
    ).length;
    const traceCount = [
      messageEvent.traceId,
      heartbeatEvent.traceId,
      memoryEvent.traceId,
    ].reduce(
      (count, traceId) =>
        count + database.llmTraces.listByTrace(traceId).length,
      0,
    );

    console.log("message workflow: completed");
    console.log("heartbeat workflow: completed");
    console.log("memory workflow: completed");
    console.log(`messages: ${messageCount}`);
    console.log(`memories: ${memoryCount}`);
    console.log(`llm traces: ${traceCount}`);
  } finally {
    database.close();
  }
}

function workflowContext(
  event: { traceId: string; sessionId?: string },
  services: WorkflowServices,
  now: () => Date,
  nextId: (prefix: string) => string,
) {
  return {
    traceId: event.traceId,
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    now,
    nextId,
    services,
  };
}

function cleanupDemoRecords(database: KaguyaDatabase): void {
  const traceIds = Object.values(DEMO_TRACE_IDS);
  database.messages.deleteBySession(DEMO_SESSION_ID);
  database.memories.deleteBySession(DEMO_SESSION_ID);
  database.eventRuns.deleteByTraceIds(traceIds);
  database.llmTraces.deleteByTraceIds(traceIds);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
