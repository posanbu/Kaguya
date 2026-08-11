import { KaguyaDatabase } from "@kaguya/database";
import { LlmLifecycleClient, type WorkflowServices } from "@kaguya/demo";
import { EventBus } from "@kaguya/engine";
import { KaguyaLlmClient } from "@kaguya/llm/client";
import { createDeterministicModel } from "@kaguya/llm/testing";
import type { PlatformReplySender } from "@kaguya/platform-adapters";
import { PromptCompiler } from "@kaguya/prompt";

export interface CreateBotWorkflowServicesOptions {
  readonly database: KaguyaDatabase;
  readonly eventBus: EventBus;
  readonly promptCompiler: PromptCompiler;
  readonly now: () => Date;
  readonly nextId: (prefix: string) => string;
  readonly platformReplySender?: PlatformReplySender;
}

export function createBotWorkflowServices(
  options: CreateBotWorkflowServicesOptions,
): WorkflowServices {
  return {
    database: options.database,
    promptCompiler: options.promptCompiler,
    llmClient: new LlmLifecycleClient(
      new KaguyaLlmClient({
        model: createDeterministicModel([
          {
            shouldReply: true,
            reason: "the platform message should enter the workflow",
          },
          { text: "It is a lovely night for watching the moon." },
        ]),
        traceWriter: options.database.llmTraces,
        now: options.now,
        nextId: options.nextId,
      }),
      options.eventBus,
    ),
    eventBus: options.eventBus,
    ...(options.platformReplySender === undefined
      ? {}
      : { platformReplySender: options.platformReplySender }),
  };
}
