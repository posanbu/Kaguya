import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import {
  createMessageWorkflow,
  dispatchEvent,
  messageReceivedEvent,
} from "@kaguya/demo";
import { EventBus, WorkflowEngine } from "@kaguya/engine";
import type {
  PlatformInboundMessage,
  PlatformReplySender,
} from "@kaguya/platform-adapters";
import { PromptCompiler } from "@kaguya/prompt";
import type { WorkflowContext } from "@kaguya/sdk";

import { createTraceScopedIdFactory } from "./id.js";
import { createBotWorkflowServices } from "./services.js";

export interface CreatePlatformDispatcherOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly platformReplySender?: PlatformReplySender;
}

export class PlatformDispatcher {
  static createForDeterministicModel(
    options: CreatePlatformDispatcherOptions,
  ): PlatformDispatcher {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    const database = KaguyaDatabase.open(options.databasePath);
    database.migrate();
    return new PlatformDispatcher({
      database,
      eventBus: new EventBus(),
      engine: new WorkflowEngine({ recorder: database.eventRuns }),
      promptCompiler: new PromptCompiler(),
      now: options.now ?? (() => new Date()),
      ...(options.platformReplySender === undefined
        ? {}
        : { platformReplySender: options.platformReplySender }),
    });
  }

  private readonly workflow = createMessageWorkflow();

  constructor(
    private readonly options: {
      readonly database: KaguyaDatabase;
      readonly eventBus: EventBus;
      readonly engine: WorkflowEngine;
      readonly promptCompiler: PromptCompiler;
      readonly now: () => Date;
      readonly platformReplySender?: PlatformReplySender;
    },
  ) {}

  async dispatchInboundMessage(message: PlatformInboundMessage): Promise<void> {
    const nextId = createTraceScopedIdFactory(message.traceId);
    const event = messageReceivedEvent.create(
      {
        id: `${message.traceId}-message-received`,
        source: `adapter:${message.adapterId}`,
        occurredAt: message.occurredAt,
        traceId: message.traceId,
        sessionId: message.sessionId,
        metadata: {
          adapterId: message.adapterId,
          platform: message.platform,
          platformMessageId: message.platformMessageId,
          ...(message.selfId === undefined ? {} : { selfId: message.selfId }),
          target: message.target,
          sender: message.sender,
        },
      },
      { text: message.text },
    );
    const services = createBotWorkflowServices({
      database: this.options.database,
      eventBus: this.options.eventBus,
      promptCompiler: this.options.promptCompiler,
      now: this.options.now,
      nextId,
      ...(this.options.platformReplySender === undefined
        ? {}
        : { platformReplySender: this.options.platformReplySender }),
    });
    services.messageReceivedEvent = event;

    const context: WorkflowContext = {
      traceId: message.traceId,
      sessionId: message.sessionId,
      now: this.options.now,
      nextId,
      services,
    };

    await dispatchEvent({
      definition: messageReceivedEvent,
      event,
      eventBus: this.options.eventBus,
      engine: this.options.engine,
      workflow: this.workflow,
      context,
    });
  }

  close(): void {
    this.options.database.close();
  }
}
