import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import { EventBus, WorkflowEngine } from "@kaguya/engine";
import { KaguyaLlmClient } from "@kaguya/llm/client";
import { createDeterministicModel } from "@kaguya/llm/testing";
import { PromptCompiler } from "@kaguya/prompt";
import type { WorkflowContext } from "@kaguya/sdk";

import { dispatchEvent } from "./dispatch.js";
import { messageReceivedEvent } from "./events.js";
import { LlmLifecycleClient } from "./llm-lifecycle.js";
import type { WorkflowServices } from "./services.js";
import { createMessageWorkflow } from "./workflows/message.js";

export interface LocalMessageIngressCommand {
  readonly sessionId: string;
  readonly text: string;
  readonly requestId: string;
}

export interface LocalMessageIngress {
  enqueue(command: LocalMessageIngressCommand): Promise<void>;
  close(): void;
}

export interface CreateLocalMessageIngressOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
}

export function createLocalMessageIngress(
  options: CreateLocalMessageIngressOptions,
): LocalMessageIngress {
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const database = KaguyaDatabase.open(options.databasePath);
  database.migrate();

  let closed = false;
  const eventBus = new EventBus();
  const now = options.now ?? (() => new Date());
  const promptCompiler = new PromptCompiler();
  const engine = new WorkflowEngine({ recorder: database.eventRuns });
  const workflow = createMessageWorkflow();

  return {
    async enqueue(command) {
      if (closed) {
        throw new Error("local message ingress is closed");
      }

      const traceId = `webui-${command.requestId}`;
      const nextId = createTraceScopedIdFactory(traceId);
      const event = messageReceivedEvent.create(
        {
          id: `${traceId}-message-received`,
          source: "webui",
          occurredAt: now().toISOString(),
          traceId,
          sessionId: command.sessionId,
          metadata: { requestId: command.requestId },
        },
        { text: command.text },
      );
      const services = createWorkflowServices(
        database,
        eventBus,
        promptCompiler,
        {
          now,
          nextId,
        },
      );
      services.messageReceivedEvent = event;
      const context: WorkflowContext = {
        traceId,
        sessionId: command.sessionId,
        now,
        nextId,
        services,
      };

      await dispatchEvent({
        definition: messageReceivedEvent,
        event,
        eventBus,
        engine,
        workflow,
        context,
      });
    },
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  };
}

function createTraceScopedIdFactory(
  traceId: string,
): (prefix: string) => string {
  let sequence = 0;
  return (prefix: string) =>
    `${traceId}-${prefix}-${String(++sequence).padStart(6, "0")}`;
}

function createWorkflowServices(
  database: KaguyaDatabase,
  eventBus: EventBus,
  promptCompiler: PromptCompiler,
  helpers: {
    readonly now: () => Date;
    readonly nextId: (prefix: string) => string;
  },
): WorkflowServices {
  return {
    database,
    promptCompiler,
    llmClient: new LlmLifecycleClient(
      new KaguyaLlmClient({
        model: createDeterministicModel([
          {
            shouldReply: true,
            reason: "the local Web UI message should enter the workflow",
          },
          { text: "It is a lovely night for watching the moon." },
        ]),
        traceWriter: database.llmTraces,
        now: helpers.now,
        nextId: helpers.nextId,
      }),
      eventBus,
    ),
    eventBus,
  };
}
