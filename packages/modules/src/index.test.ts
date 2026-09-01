/**
 * 功能概述：本文件验证 `packages/modules` 中消息过滤模块与 LLM 回复模块的公开契约，
 * 重点覆盖消息入站后如何生成定向回复请求、如何把模块设置转换成运行时 LLM 调用，
 * 以及回复模块对外发消息参数的选择规则。
 * 主要职责：`alwaysReplyFilterModule` 相关用例确保每条入站消息都会被转成指向指定回复实例
 * 的 `replyRequestedEvent`；`createLlmReplyModule` 相关用例验证 prompt 编译、出站消息构造、
 * LLM 失败传播，以及本次变更要求的“模块只能声明 `modelTier`，不得再携带 `profileId`”。
 * 代码库关系：这里直接依赖 `llm-reply.ts` 的 schema 与模块工厂、`events.ts` 的事件定义，
 * 并通过 `@kaguya/schema`/`@kaguya/sdk` 的真实类型约束调用面；运行时 `packages/runtime`
 * 和服务启动层 `apps/server` 依赖这些契约把 Profile 选择固定到服务启动阶段。
 * 输入输出与副作用：测试通过内存事件数组和伪造的 LLM 执行器观察模块输出，不触碰真实网络
 * 或数据库；当 schema、事件 payload 或 LLM selection 结构改变时，本文件会作为回归保护，
 * 防止模块重新接受按调用覆盖 Profile 的旧行为。
 */
import { PromptCompiler } from "@kaguya/prompt";
import type { EventEnvelope, MessageRecord } from "@kaguya/schema";
import type {
  EventDefinition,
  ModuleHandlerContext,
  ModuleInstance,
} from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

import { alwaysReplyFilterModule } from "./always-reply-filter.js";
import {
  messageIngestedEvent,
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

  it("rejects profile overrides and keeps only tier selection across reply instances", async () => {
    expect(
      llmReplySettingsSchema.safeParse({
        profileId: globalThis.crypto.randomUUID(),
        modelTier: "light",
        outbound: { mode: "source", messageKind: "text" },
      }).success,
    ).toBe(false);

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
        modelTier: "light",
        outbound: { mode: "source", messageKind: "text" },
      }),
    );
    const heavy = await createInstance(
      definition,
      "reply.heavy",
      llmReplySettingsSchema.parse({
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
      { modelTier: "light" },
      { modelTier: "heavy" },
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
