import { PromptCompiler } from "@kaguya/prompt";
import type {
  EventEnvelope,
  MemoryRecord,
  MessageRecord,
} from "@kaguya/schema";
import type {
  EventDefinition,
  ModuleHandlerContext,
  ModuleInstance,
} from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

import { alwaysReplyFilterModule } from "./always-reply-filter.js";
import {
  messageIngestedEvent,
  replyGeneratedEvent,
  replyRequestedEvent,
  type ModuleMessage,
} from "./events.js";
import { createLlmReplyModule, llmReplySettingsSchema } from "./llm-reply.js";

const moduleMessage: ModuleMessage = {
  messageId: "message-1",
  text: "@998877 hello",
  conversation: { kind: "group", id: "778899" },
  sender: { id: "112233", displayName: "Ada" },
  mentions: [{ kind: "user", id: "998877" }],
  origin: {
    platform: "qq",
    adapterId: "napcat.qq.main",
    messageId: "platform-1",
    selfId: "998877",
  },
};

function eventBase() {
  return {
    id: "event-1",
    source: "test",
    occurredAt: "2026-08-13T00:00:00.000Z",
    traceId: "trace-1",
    sessionId: "qq:group:778899",
    metadata: {},
  };
}

async function createInstance<TSettings>(
  definition: {
    create(options: {
      instanceId: string;
      settings: TSettings;
    }): Promise<ModuleInstance> | ModuleInstance;
  },
  instanceId: string,
  settings: TSettings,
): Promise<ModuleInstance> {
  return definition.create({ instanceId, settings });
}

function handlerContext(
  instanceId: string,
  sourceEvent: EventEnvelope,
  emitted: EventEnvelope[],
): ModuleHandlerContext {
  let sequence = 0;
  return {
    definitionId: `definition:${instanceId}`,
    instanceId,
    traceId: sourceEvent.traceId,
    ...(sourceEvent.sessionId === undefined
      ? {}
      : { sessionId: sourceEvent.sessionId }),
    sourceEvent,
    now: () => new Date("2026-08-13T00:00:01.000Z"),
    nextId: (prefix) => `${sourceEvent.traceId}-${prefix}-${++sequence}`,
    emit: async <TType extends string, TPayload>(
      definition: EventDefinition<TType, TPayload>,
      payload: TPayload,
      metadata: Record<string, unknown> = {},
    ) => {
      const event = definition.create(
        {
          ...eventBase(),
          id: `${sourceEvent.traceId}-event-${++sequence}`,
          source: `module:${instanceId}`,
          metadata,
        },
        payload,
      );
      emitted.push(event);
      return event;
    },
  };
}

describe("alwaysReplyFilterModule", () => {
  it("turns every ingested message into a targeted reply request", async () => {
    const settings = alwaysReplyFilterModule.manifest.settingsSchema.parse({
      replyTargetInstanceId: "reply.default",
    });
    const instance = await createInstance(
      alwaysReplyFilterModule,
      "filter.default",
      settings,
    );
    const source = messageIngestedEvent.create(eventBase(), {
      message: moduleMessage,
    });
    const emitted: EventEnvelope[] = [];

    await instance.subscriptions[0]?.handle(
      source,
      handlerContext("filter.default", source, emitted),
    );

    expect(instance.subscriptions).toHaveLength(1);
    expect(instance.subscriptions[0]).toMatchObject({
      event: messageIngestedEvent,
      targeted: false,
    });
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: replyRequestedEvent.type,
        payload: {
          targetInstanceId: "reply.default",
          messageId: "message-1",
        },
      }),
    );
  });
});

describe("createLlmReplyModule", () => {
  const userMessage: MessageRecord = {
    id: "message-1",
    sessionId: "qq:group:778899",
    role: "user",
    content: "@998877 hello",
    occurredAt: "2026-08-13T00:00:00.000Z",
    metadata: { messageContext: moduleMessage },
  };
  const memory: MemoryRecord = {
    id: "memory-1",
    sessionId: userMessage.sessionId,
    content: "Ada likes moonlight.",
    occurredAt: "2026-08-12T00:00:00.000Z",
    metadata: {},
  };

  it("only subscribes to targeted reply requests and emits generated text", async () => {
    const requests: unknown[] = [];
    const definition = createLlmReplyModule({
      conversationReader: {
        load: () => ({ messages: [userMessage], memories: [memory] }),
      },
      promptCompiler: new PromptCompiler(),
      llm: {
        async generate(request) {
          requests.push(request);
          return { text: "Hello Ada." };
        },
      },
    });
    const settings = llmReplySettingsSchema.parse({ modelId: "model-1" });
    const instance = await createInstance(
      definition,
      "reply.default",
      settings,
    );
    const source = replyRequestedEvent.create(eventBase(), {
      targetInstanceId: "reply.default",
      messageId: "message-1",
    });
    const emitted: EventEnvelope[] = [];

    await instance.subscriptions[0]?.handle(
      source,
      handlerContext("reply.default", source, emitted),
    );

    expect(instance.subscriptions).toHaveLength(1);
    expect(instance.subscriptions[0]).toMatchObject({
      event: replyRequestedEvent,
      targeted: true,
    });
    expect(requests).toContainEqual(
      expect.objectContaining({
        kind: "reply",
        modelId: "model-1",
        workflowId: "message-module-pipeline",
        nodeId: "reply.default",
        prompt: expect.objectContaining({
          text: expect.stringContaining("reply-current-message-context"),
        }),
      }),
    );
    expect(JSON.stringify(requests)).toContain("mentions");
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: replyGeneratedEvent.type,
        payload: { messageId: "message-1", text: "Hello Ada." },
      }),
    );
  });

  it("does not publish reply.generated when generation fails", async () => {
    const generationError = new Error("model unavailable");
    const definition = createLlmReplyModule({
      conversationReader: {
        load: () => ({ messages: [userMessage], memories: [] }),
      },
      promptCompiler: new PromptCompiler(),
      llm: {
        async generate() {
          throw generationError;
        },
      },
    });
    const instance = await createInstance(
      definition,
      "reply.default",
      llmReplySettingsSchema.parse({ modelId: "model-1" }),
    );
    const source = replyRequestedEvent.create(eventBase(), {
      targetInstanceId: "reply.default",
      messageId: "message-1",
    });
    const emitted: EventEnvelope[] = [];

    await expect(
      instance.subscriptions[0]?.handle(
        source,
        handlerContext("reply.default", source, emitted),
      ),
    ).rejects.toBe(generationError);
    expect(emitted).toEqual([]);
  });

  it("does not publish reply.generated for an invalid LLM output", async () => {
    const definition = createLlmReplyModule({
      conversationReader: {
        load: () => ({ messages: [userMessage], memories: [] }),
      },
      promptCompiler: new PromptCompiler(),
      llm: {
        async generate() {
          return { text: "   " };
        },
      },
    });
    const instance = await createInstance(
      definition,
      "reply.default",
      llmReplySettingsSchema.parse({ modelId: "model-1" }),
    );
    const source = replyRequestedEvent.create(eventBase(), {
      targetInstanceId: "reply.default",
      messageId: "message-1",
    });
    const emitted: EventEnvelope[] = [];

    await expect(
      instance.subscriptions[0]?.handle(
        source,
        handlerContext("reply.default", source, emitted),
      ),
    ).rejects.toThrow();
    expect(emitted).toEqual([]);
  });
});
