import { KaguyaDatabase } from "@kaguya/database";
import { EventBus } from "@kaguya/engine";
import { PromptCompiler } from "@kaguya/prompt";
import type { EventEnvelope } from "@kaguya/schema";
import type { WorkflowContext } from "@kaguya/sdk";

import { LlmLifecycleClient } from "./llm-lifecycle.js";

export interface WorkflowServices extends Record<string, unknown> {
  database: KaguyaDatabase;
  promptCompiler: PromptCompiler;
  llmClient?: LlmLifecycleClient;
  eventBus: EventBus;
  messageReceivedEvent?: EventEnvelope;
}

export function getDatabase(context: WorkflowContext): KaguyaDatabase {
  const service = context.services.database;
  if (!(service instanceof KaguyaDatabase)) {
    throw new Error("workflow service database is not configured");
  }
  return service;
}

export function getPromptCompiler(context: WorkflowContext): PromptCompiler {
  const service = context.services.promptCompiler;
  if (!(service instanceof PromptCompiler)) {
    throw new Error("workflow service promptCompiler is not configured");
  }
  return service;
}

export function getLlmClient(context: WorkflowContext): LlmLifecycleClient {
  const service = context.services.llmClient;
  if (!(service instanceof LlmLifecycleClient)) {
    throw new Error("workflow service llmClient is not configured");
  }
  return service;
}

export function getEventBus(context: WorkflowContext): EventBus {
  const service = context.services.eventBus;
  if (!(service instanceof EventBus)) {
    throw new Error("workflow service eventBus is not configured");
  }
  return service;
}
