import { PromptCompiler } from "@kaguya/prompt";
import type { EventEnvelope, MessageRecord } from "@kaguya/schema";
import type {
  EventDefinition,
  ModuleHandlerContext,
  ModuleInstance,
} from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import { alwaysReplyFilterModule } from "./always-reply-filter.js";
import {
  messageIngestedEvent,
  messagePersistedEvent,
  moduleMessageSchema,
  outboundMessageRequestedEvent,
  replyRequestedEvent,
  type ModuleMessage,
} from "./events.js";
import { createLlmReplyModule, llmReplySettingsSchema } from "./llm-reply.js";

const moduleMessage: ModuleMessage = {
  messageId: "message-1",
  text: "@998877 hello",
  occurredAt: "2026-08-13T00:00:00.000Z",
  source: {
    kind: "platform",
    platform: "qq",
    adapterId: "napcat.qq.main",
    platformMessageId: "platform-1",
    selfId: "998877",
    destination: { kind: "group", groupId: "778899" },
    sender: { id: "112233", displayName: "Ada" },
    mentions: [{ kind: "user", id: "998877" }],
  },
};

function eventBase() {
  return {
    id: "event-1",
    source: "test",
    occurredAt: "2026-08-13T00:00:00.000Z",
    traceId: "trace-1",
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
    role: "user",
    content: moduleMessage.text,
    occurredAt: moduleMessage.occurredAt,
    metadata: { moduleMessage },
  };

  const webUserMessage: ModuleMessage = {
    messageId: "web-message-1",
    text: "hello from web",
    occurredAt: "2026-08-13T00:00:00.000Z",
    source: {
      kind: "web",
      requestId: "request-1",
      sessionId: "session-1",
    },
  };
  const webUserRecord: MessageRecord = {
    id: "web-message-1",
    role: "user",
    content: webUserMessage.text,
    occurredAt: webUserMessage.occurredAt,
    metadata: { moduleMessage: webUserMessage },
  };

  it("uses only the current message and emits a platform reply request", async () => {
    const requests: unknown[] = [];
    const definition = createLlmReplyModule({
      messageReader: { getById: () => userMessage },
      promptCompiler: new PromptCompiler(),
      llm: {
        async generate(request) {
          requests.push(request);
          return { text: "Hello Ada." };
        },
      },
    });
    const settings = llmReplySettingsSchema.parse({
      modelTier: "heavy",
      outbound: { mode: "source", messageKind: "reply" },
    });
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

    expect(requests).toContainEqual(
      expect.objectContaining({
        kind: "reply",
        selection: { modelTier: "heavy" },
        prompt: expect.objectContaining({
          text: expect.stringContaining("reply-current-message-context"),
        }),
      }),
    );
    expect(JSON.stringify(requests)).toContain("mentions");
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: outboundMessageRequestedEvent.type,
        payload: {
          adapterId: "napcat.qq.main",
          platform: "qq",
          destination: { kind: "group", groupId: "778899" },
          message: {
            kind: "reply",
            replyToPlatformMessageId: "platform-1",
            text: "Hello Ada.",
          },
        },
      }),
    );
  });

  it("persists a Web reply as an assistant message", async () => {
    const insert = vi.fn(async (_record: MessageRecord) => undefined);
    const definition = createLlmReplyModule({
      messageReader: { getById: () => webUserRecord },
      promptCompiler: new PromptCompiler(),
      llm: { generate: async () => ({ text: "Good evening." }) },
      messageWriter: { insert },
    });
    const instance = await createInstance(
      definition,
      "reply.default",
      llmReplySettingsSchema.parse({
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      }),
    );
    const source = replyRequestedEvent.create(eventBase(), {
      targetInstanceId: "reply.default",
      messageId: "web-message-1",
    });
    const emitted: EventEnvelope[] = [];

    await instance.subscriptions[0]?.handle(
      source,
      handlerContext("reply.default", source, emitted),
    );

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({
      id: "trace-1-message-1",
      role: "assistant",
      content: "Good evening.",
      occurredAt: "2026-08-13T00:00:01.000Z",
      metadata: {
        traceId: "trace-1",
        requestId: "request-1",
        sourceMessageId: "web-message-1",
        sessionId: "session-1",
      },
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        type: messagePersistedEvent.type,
        payload: { messageId: "trace-1-message-1", role: "assistant" },
      }),
    ]);
  });

  it("never calls the message writer for platform sources", async () => {
    const insert = vi.fn(async (_record: MessageRecord) => undefined);
    const definition = createLlmReplyModule({
      messageReader: { getById: () => userMessage },
      promptCompiler: new PromptCompiler(),
      llm: { generate: async () => ({ text: "Hello Ada." }) },
      messageWriter: { insert },
    });
    const instance = await createInstance(
      definition,
      "reply.default",
      llmReplySettingsSchema.parse({
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      }),
    );
    const source = replyRequestedEvent.create(eventBase(), {
      targetInstanceId: "reply.default",
      messageId: "message-1",
    });

    await instance.subscriptions[0]?.handle(
      source,
      handlerContext("reply.default", source, []),
    );

    expect(insert).not.toHaveBeenCalled();
  });

  it("can choose a fixed destination independently of the source", async () => {
    const definition = createLlmReplyModule({
      messageReader: { getById: () => userMessage },
      promptCompiler: new PromptCompiler(),
      llm: { generate: async () => ({ text: "Elsewhere" }) },
    });
    const instance = await createInstance(
      definition,
      "reply.fixed",
      llmReplySettingsSchema.parse({
        profileId: "profile-2",
        modelTier: "light",
        outbound: {
          mode: "fixed",
          adapterId: "napcat.qq.other",
          platform: "qq",
          destination: { kind: "private", userId: "42" },
          messageKind: "text",
        },
      }),
    );
    const source = replyRequestedEvent.create(eventBase(), {
      targetInstanceId: "reply.fixed",
      messageId: "message-1",
    });
    const emitted: EventEnvelope[] = [];

    await instance.subscriptions[0]?.handle(
      source,
      handlerContext("reply.fixed", source, emitted),
    );
    expect(emitted[0]?.payload).toMatchObject({
      adapterId: "napcat.qq.other",
      destination: { kind: "private", userId: "42" },
      message: { kind: "text", text: "Elsewhere" },
    });
  });

  it("keeps profile and tier selection independent across reply instances", async () => {
    const selections: unknown[] = [];
    const definition = createLlmReplyModule({
      messageReader: { getById: () => userMessage },
      promptCompiler: new PromptCompiler(),
      llm: {
        async generate(request) {
          selections.push(request.selection);
          return { text: "selected" };
        },
      },
    });
    const light = await createInstance(
      definition,
      "reply.light",
      llmReplySettingsSchema.parse({
        profileId: "profile-light",
        modelTier: "light",
        outbound: { mode: "source", messageKind: "text" },
      }),
    );
    const heavy = await createInstance(
      definition,
      "reply.heavy",
      llmReplySettingsSchema.parse({
        profileId: "profile-heavy",
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      }),
    );
    const lightSource = replyRequestedEvent.create(eventBase(), {
      targetInstanceId: "reply.light",
      messageId: "message-1",
    });
    const heavySource = replyRequestedEvent.create(
      { ...eventBase(), id: "event-2" },
      {
        targetInstanceId: "reply.heavy",
        messageId: "message-1",
      },
    );

    await light.subscriptions[0]?.handle(
      lightSource,
      handlerContext("reply.light", lightSource, []),
    );
    await heavy.subscriptions[0]?.handle(
      heavySource,
      handlerContext("reply.heavy", heavySource, []),
    );

    expect(selections).toEqual([
      { profileId: "profile-light", modelTier: "light" },
      { profileId: "profile-heavy", modelTier: "heavy" },
    ]);
  });

  it("does not emit outbound when generation fails", async () => {
    const failure = new Error("model unavailable");
    const definition = createLlmReplyModule({
      messageReader: { getById: () => userMessage },
      promptCompiler: new PromptCompiler(),
      llm: { generate: async () => Promise.reject(failure) },
    });
    const instance = await createInstance(
      definition,
      "reply.default",
      llmReplySettingsSchema.parse({
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      }),
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
    ).rejects.toBe(failure);
    expect(emitted).toEqual([]);
  });
});

describe("moduleMessageSchema", () => {
  it("accepts an optional sessionId on Web sources", () => {
    expect(
      moduleMessageSchema.parse({
        messageId: "web-1",
        text: "hello",
        occurredAt: "2026-08-13T00:00:00.000Z",
        source: { kind: "web", requestId: "request-1" },
      }).source,
    ).toEqual({ kind: "web", requestId: "request-1" });
    expect(
      moduleMessageSchema.parse({
        messageId: "web-2",
        text: "hello",
        occurredAt: "2026-08-13T00:00:00.000Z",
        source: {
          kind: "web",
          requestId: "request-1",
          sessionId: "session-1",
        },
      }).source,
    ).toEqual({
      kind: "web",
      requestId: "request-1",
      sessionId: "session-1",
    });
  });

  it("rejects a sessionId on platform sources", () => {
    const result = moduleMessageSchema.safeParse({
      messageId: "platform-1",
      text: "hello",
      occurredAt: "2026-08-13T00:00:00.000Z",
      source: {
        kind: "platform",
        platform: "qq",
        adapterId: "napcat.qq.main",
        platformMessageId: "platform-1",
        destination: { kind: "group", groupId: "778899" },
        sender: { id: "112233" },
        mentions: [],
        sessionId: "session-1",
      },
    });
    expect(result.success).toBe(false);
  });
});
