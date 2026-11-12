/**
 * 升级兼容回归跨页查询旧投递；pending/delivered/unknown及确认因果链均阻止重复输出。
 * 功能概述：验证消息编写的严格意图契约及 intent→Model Task→assistant→纯文本投递三个阶段。
 * 有序输出用例检查纯媒体、图文顺序和冻结请求授权，未允许引用不得登记待发消息。
 * 主要职责：保护 modelTier 唯一配置、完整 turn Prompt、失败与取消无业务写入、完成任务 task/version/definition/tier 过滤及外部实例隔离与目标元数据最小化。
 * 后缀模板用例验证构造时拒绝非法变量、背景覆盖的重复插值与实际溯源，以及表达习惯使用注入模板。
 * 代码库关系：真实模块订阅与 schema 配合受限内存 handler context；不绕过编译器或输出校验。
 * 输入输出与副作用：记录模型执行与 registerOnce 调用，无真实模型、数据库或网络。
 */
import { describe, expect, it, vi } from "vitest";
import {
  defineInformationKind,
  defineModuleCapability,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import {
  assistantTextInformationKind,
  authorizedAssistantOutputInformationKind,
  messageIntentRequestedInformationPayloadSchema,
} from "../information-kinds.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import {
  messageAuthorizationCapability,
  type MessageAuthorization,
} from "../message-authorization.js";
import {
  createHeavyModule,
  heavySettingsSchema,
  messageTaskOutputSchema,
  messageResponseOutputSchema,
  type ModelTaskRequest,
  type ModelTaskResult,
  type ModelTaskCapability,
  type HeavyPromptTemplates,
} from "./index.js";
import { atom, fixture, identity, target } from "./test-fixtures.js";
const token = defineModuleCapability<ModelTaskCapability>(
  "kaguya:model-task",
  1,
);
const completedKind = defineInformationKind({
  kind: "core.model.task.completed",
  displayName: "Completed",
  description: "Test completion",
  payloadSchema: z
    .object({
      taskId: z.string(),
      version: z.string(),
      sourceInformationId: z.string(),
      activation: z
        .object({ instanceId: z.string(), definitionId: z.string() })
        .strict(),
      selectionPolicy: z.object({ tier: z.enum(["light", "heavy"]) }).strict(),
      output: z.union([z.string(), messageResponseOutputSchema]),
    })
    .strict(),
  references: {},
  log: { enabled: false },
});
const activation = {
  instanceId: "heavy.default",
  definitionId: "agent.heavy",
};
async function setup(
  expressionEnabled = false,
  promptOverrides: Partial<HeavyPromptTemplates> = {},
  authorization?: MessageAuthorization,
) {
  const f = fixture();
  const execute = vi.fn(
    async (
      _request: ModelTaskRequest<unknown>,
    ): Promise<ModelTaskResult<string>> => ({
      status: "completed" as const,
      output: "COMPOSED",
      requestedInformationId: "request-1",
      terminalInformationId: "completed-1",
    }),
  );
  const registerOnce = vi.fn(async () => f.intent);
  const definition = createHeavyModule({
    modelTaskCapability: token,
    modelTaskCompletedInformationKind: completedKind,
    ...(authorization ? { messageAuthorizationCapability } : {}),
    promptTemplates: {
      ...loadFirstPartyPromptTemplates().heavy,
      ...promptOverrides,
    },
    agentIdentity: identity,
  });
  const context = {
    sourceAtom: f.intent,
    instanceId: activation.instanceId,
    definitionId: activation.definitionId,
    signal: new AbortController().signal,
    now: () => new Date(),
    report: vi.fn(),
    select: vi.fn(async () => f.atoms),
    registerOnce,
    use: (capability: { id: string }) =>
      capability.id === messageAuthorizationCapability.id
        ? authorization
        : { execute, cancel: vi.fn() },
  } as unknown as InformationModuleHandlerContext;
  const instance = await definition.create(
    {
      instanceId: activation.instanceId,
      settings: {},
      activation,
    },
    context,
  );
  return { f, execute, registerOnce, definition, context, instance };
}
describe("message composer", () => {
  it.each(["scene", "conversationBackground"] as const)(
    "rejects invalid %s variables during module construction",
    (key) => {
      expect(() =>
        createHeavyModule({
          modelTaskCapability: token,
          modelTaskCompletedInformationKind: completedKind,
          promptTemplates: {
            ...loadFirstPartyPromptTemplates().heavy,
            [key]: "{{undeclared}}",
          },
          agentIdentity: identity,
        }),
      ).toThrow("Unknown Prompt variable");
    },
  );
  it("renders every background interpolation from the configured suffix and retains its source", async () => {
    const background = { name: "A&B <群聊>", participants: [] };
    const conversation = atom(
      "conversation-1",
      "agent.router.conversation.context.frozen",
      {
        background,
        resolution: { reference: "MUST_NOT_REACH_COMPOSER" },
      },
    );
    const conversationBackground =
      "\n背景={{conversation_background}}\n复核={{conversation_background}}";
    const conversationLookup = vi.fn(async () => conversation);
    const s = await setup(
      false,
      { conversationBackground },
      {
        prepare: async () => undefined,
        conversation: conversationLookup,
        stage: async () => true,
      },
    );
    await s.instance.subscriptions[0]!.handle(s.f.intent as never, s.context);
    expect(conversationLookup).toHaveBeenCalledWith(s.f.turn);
    const request = s.execute.mock.calls[0]![0];
    expect(request.prompt.text).toContain(
      `背景=${JSON.stringify(background)}\n复核=${JSON.stringify(background)}`,
    );
    expect(request.prompt.text).not.toContain("MUST_NOT_REACH_COMPOSER");
    expect(
      request.prompt.templates.filter(
        (entry) => entry.name === "conversation-background",
      ),
    ).toEqual([
      { name: "conversation-background", content: conversationBackground },
    ]);
    expect(
      request.prompt.variables.find(
        (entry) => entry.name === "conversation_background",
      ),
    ).toEqual({
      name: "conversation_background",
      content: JSON.stringify(background),
      informationIds: [conversation.informationId],
    });
    expect(request.contextAtoms).toContain(conversation);
  });
  it("requires every intent field and rejects copied inbound bodies/source and outbound settings", () => {
    const payload = fixture().intent.payload;
    expect(
      messageIntentRequestedInformationPayloadSchema.parse(payload),
    ).toEqual(payload);
    for (const field of ["target", "turn", "memoryInformationIds"]) {
      const missing = { ...payload };
      delete missing[field];
      expect(
        messageIntentRequestedInformationPayloadSchema.safeParse(missing)
          .success,
      ).toBe(false);
    }
    expect(
      messageIntentRequestedInformationPayloadSchema.safeParse({
        ...payload,
        text: "copied",
      }).success,
    ).toBe(false);
    expect(
      messageIntentRequestedInformationPayloadSchema.safeParse({
        ...payload,
        source: target,
      }).success,
    ).toBe(false);
    expect(heavySettingsSchema.parse({})).toEqual({});
    for (const outbound of [
      { mode: "source", messageKind: "reply" },
      { mode: "fixed", ...target },
    ])
      expect(
        heavySettingsSchema.safeParse({
          outbound,
        }).success,
      ).toBe(false);
    expect(messageTaskOutputSchema.parse(" text ")).toBe("text");
    expect(messageTaskOutputSchema.safeParse("  ").success).toBe(false);
    expect(messageTaskOutputSchema.safeParse({ text: "x" }).success).toBe(
      false,
    );
    expect(messageResponseOutputSchema.parse({ action: "silent" })).toEqual({
      action: "silent",
    });
    expect(
      messageResponseOutputSchema.parse({ action: "message", text: " 好 " }),
    ).toEqual({ action: "message", text: "好" });
    expect(
      messageResponseOutputSchema.safeParse({ action: "message", text: "  " })
        .success,
    ).toBe(false);
  });
  it("dispatches one structured task with the complete frozen turn and canonical diagnostics", async () => {
    const s = await setup();
    expect(s.definition.manifest.definitionId).toBe("agent.heavy");
    expect(s.definition.manifest.requires).toEqual([
      { id: "agent:message-output-processor", apiVersion: 1 },
      { id: "kaguya:model-task", apiVersion: 1 },
      { id: "kaguya:schedule.one-shot", apiVersion: 1 },
    ]);
    await s.instance.subscriptions[0]!.handle(s.f.intent as never, s.context);
    expect(s.execute).toHaveBeenCalledTimes(1);
    const request = s.execute.mock.calls[0]![0] as unknown as {
      task: { taskId: string; outputMode: string };
      prompt: { text: string };
      contextAtoms: unknown;
    };
    expect(request.task).toMatchObject({
      taskId: "agent.heavy.respond",
      outputMode: "object",
    });
    expect(request.prompt.text).toContain("FIRST_INPUT");
    expect(request.prompt.text).toContain("LAST_INPUT");
    expect(request.contextAtoms).toEqual(s.f.atoms);
    expect(s.context.report).toHaveBeenCalledWith(
      expect.objectContaining({ event: "heavy.model.dispatching" }),
      expect.objectContaining({
        taskId: "agent.heavy.respond",
        globalContextCharacters: expect.any(Number),
        scopeContextCharacters: expect.any(Number),
      }),
    );
    expect(s.registerOnce).not.toHaveBeenCalled();
  });
  it("replays a persisted Heavy request with its original Prompt", async () => {
    const s = await setup();
    const oldPrompt = {
      templateId: "persisted-heavy",
      text: "PERSISTED_PROMPT",
      templates: [],
      variables: [],
    };
    const persisted = atom("old-heavy-request", "core.model.task.requested", {
      taskId: "agent.heavy.respond",
      activation,
      prompt: oldPrompt,
      contextInformationIds: s.f.atoms.map((item) => item.informationId),
    });
    vi.mocked(s.context.select).mockResolvedValue([...s.f.atoms, persisted]);
    await s.instance.subscriptions[0]!.handle(s.f.intent as never, s.context);
    expect(s.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ taskId: "agent.heavy.respond" }),
        prompt: oldPrompt,
        contextAtoms: s.f.atoms,
      }),
    );
  });
  it("records target-only assistant and authorized output, preserving turn without reply markers", async () => {
    const s = await setup();
    const completed = atom("completed-1", completedKind.kind, {
      taskId: "agent.heavy.respond",
      sourceInformationId: s.f.intent.informationId,
      activation: { ...activation, instanceId: "another-instance" },
      selectionPolicy: { tier: "heavy" },
      output: " COMPOSED ",
    });
    await s.instance.subscriptions[1]!.handle(completed as never, s.context);
    expect(s.registerOnce).toHaveBeenCalledWith(
      "kaguya.heavy.assistant.v1",
      `${activation.instanceId}:completed-1`,
      assistantTextInformationKind,
      {
        payload: {
          text: "COMPOSED",
          source: target,
          originatingModuleInstanceId: activation.instanceId,
          turn: s.f.intent.payload.turn,
        },
      },
    );
    const assistant = atom("assistant-1", assistantTextInformationKind.kind, {
      text: "COMPOSED",
      source: { ...target, selfId: "bot-1", platformMessageId: "sent-1" },
      originatingModuleInstanceId: activation.instanceId,
      turn: messageIntentRequestedInformationPayloadSchema.parse(
        s.f.intent.payload,
      ).turn,
    });
    await s.instance.subscriptions[2]!.handle(assistant as never, {
      ...s.context,
      sourceAtom: assistant,
    });
    expect(s.registerOnce).toHaveBeenLastCalledWith(
      "kaguya.heavy.authorized-output.v1",
      `${activation.instanceId}:assistant-1`,
      expect.anything(),
      {
        payload: assistant.payload,
      },
    );
  });
  it.each(["pure", "mixed"])(
    "preserves %s media output and its frozen request through assistant registration",
    async (mode) => {
      const s = await setup();
      const mediaId = `media:${"a".repeat(64)}`;
      const contentSegments =
        mode === "pure"
          ? [{ kind: "mediaRef" as const, mediaId }]
          : [
              { kind: "text" as const, text: "before" },
              { kind: "mediaRef" as const, mediaId },
              { kind: "text" as const, text: "after" },
            ];
      const text = mode === "pure" ? "" : "beforeafter";
      const requested = atom("request-media", "core.model.task.requested", {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  mediaInput: {
                    mediaId,
                    resourceId: `sha256:${"b".repeat(64)}`,
                    mode: "off",
                    status: "vision-off",
                  },
                }),
              },
            ],
          },
        ],
      });
      vi.mocked(s.context.select).mockResolvedValue([...s.f.atoms, requested]);
      const completed = atom("completed-media", completedKind.kind, {
        taskId: "agent.heavy.respond",
        sourceInformationId: s.f.intent.informationId,
        activation,
        selectionPolicy: { tier: "heavy" },
        outputMode: "object",
        output: { action: "message", text, contentSegments },
      });
      await s.instance.subscriptions[1]!.handle(completed as never, s.context);
      expect(s.registerOnce).toHaveBeenCalledTimes(1);
      expect(s.registerOnce).toHaveBeenCalledWith(
        "kaguya.heavy.assistant.v1",
        `${activation.instanceId}:completed-media`,
        assistantTextInformationKind,
        {
          payload: {
            text,
            contentSegments,
            mediaRequestInformationId: requested.informationId,
            source: target,
            originatingModuleInstanceId: activation.instanceId,
            turn: s.f.intent.payload.turn,
          },
        },
      );
    },
  );
  it("rejects fabricated or unavailable media references before creating an assistant", async () => {
    const s = await setup();
    const mediaId = `media:${"a".repeat(64)}`;
    const requested = atom("request-media", "core.model.task.requested", {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                mediaInput: {
                  mediaId,
                  resourceId: `sha256:${"b".repeat(64)}`,
                  mode: "native",
                  status: "vision-unavailable",
                },
              }),
            },
          ],
        },
      ],
    });
    vi.mocked(s.context.select).mockResolvedValue([...s.f.atoms, requested]);
    const completed = atom("completed-media", completedKind.kind, {
      taskId: "agent.heavy.respond",
      sourceInformationId: s.f.intent.informationId,
      activation,
      selectionPolicy: { tier: "heavy" },
      outputMode: "object",
      output: {
        action: "message",
        text: "",
        contentSegments: [{ kind: "mediaRef", mediaId }],
      },
    });
    await expect(
      s.instance.subscriptions[1]!.handle(completed as never, s.context),
    ).rejects.toThrow("MEDIA_OUTPUT_NOT_IN_FROZEN_INPUT");
    expect(s.registerOnce).not.toHaveBeenCalled();
    expect(
      messageResponseOutputSchema.safeParse({
        action: "message",
        text: "different",
        contentSegments: [{ kind: "text", text: "actual" }],
      }).success,
    ).toBe(false);
    expect(
      messageResponseOutputSchema.safeParse({
        action: "message",
        text: "",
        contentSegments: [],
      }).success,
    ).toBe(false);
  });
  it("ignores foreign task definitions and model tiers before selecting context", async () => {
    const s = await setup();
    for (const override of [
      { taskId: "foreign.task" },
      { taskId: "core.reply.generate" },
      { selectionPolicy: { tier: "light" } },
      { activation: { ...activation, definitionId: "foreign.module" } },
    ]) {
      const completed = atom("completed-1", completedKind.kind, {
        taskId: "agent.heavy.respond",
        sourceInformationId: "intent-1",
        activation,
        selectionPolicy: { tier: "heavy" },
        output: "COMPOSED",
        ...override,
      });
      await s.instance.subscriptions[1]!.handle(completed as never, s.context);
    }
    expect(s.context.select).not.toHaveBeenCalled();
    expect(s.registerOnce).not.toHaveBeenCalled();
  });
});

it("validates the completion→request→intent causal chain", async () => {
  const s = await setup();
  const selector = s.definition.manifest.selectors.find(
    (entry) => entry.selectorId === "kaguya.heavy.completed-source",
  )!;
  const completed = atom("completed-1", completedKind.kind, {
    sourceInformationId: s.f.intent.informationId,
  });
  const requested = atom("request-1", "core.model.task.requested", {});
  const ledger = {
    find: async () => [],
    retrieve: async () => [],
    related: async ({ from }: { from: readonly string[] }) =>
      from.includes("completed-1") ? [requested] : [s.f.intent],
  };
  await expect(
    selector.select({ sourceAtom: completed, ledger }),
  ).resolves.toEqual([s.f.intent.informationId, "request-1"]);
  const forged = atom("completed-1", completedKind.kind, {
    sourceInformationId: "different-intent",
  });
  await expect(selector.select({ sourceAtom: forged, ledger })).rejects.toThrow(
    "message intent cause",
  );
  ledger.related = async () => [s.f.intent];
  await expect(
    selector.select({ sourceAtom: completed, ledger }),
  ).rejects.toThrow("reference its request");
});

it.each(["failed", "cancelled"] as const)(
  "does not write assistant or delivery when the model task is %s",
  async (status) => {
    const s = await setup();
    const result: ModelTaskResult<string> =
      status === "failed"
        ? {
            status,
            requestedInformationId: "request-1",
            terminalInformationId: "failed-1",
            error: {
              name: "ModelTaskError",
              kind: "retryable",
              stage: "provider-request",
              message: "Model task generation failed",
            },
          }
        : {
            status,
            requestedInformationId: "request-1",
            terminalInformationId: "cancelled-1",
            reason: "Explicit cancellation requested",
          };
    s.execute.mockResolvedValueOnce(result);
    await s.instance.subscriptions[0]!.handle(s.f.intent as never, s.context);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.registerOnce).not.toHaveBeenCalled();
  },
);

it("does not deliver assistant text originating from another module instance", async () => {
  const s = await setup();
  const assistant = atom(
    "foreign-assistant",
    assistantTextInformationKind.kind,
    {
      text: "OTHER_INSTANCE_TEXT",
      source: target,
      originatingModuleInstanceId: "heavy.other",
      turn: messageIntentRequestedInformationPayloadSchema.parse(
        s.f.intent.payload,
      ).turn,
    },
  );
  await s.instance.subscriptions[2]!.handle(assistant as never, s.context);
  expect(s.context.select).not.toHaveBeenCalled();
  expect(s.registerOnce).not.toHaveBeenCalled();
});

it.each(["pending", "delivered", "unknown"] as const)(
  "keeps legacy %s delivery identity across both assistant and confirmed replay",
  async (status) => {
    for (const legacyCause of ["assistant", "confirmed"] as const) {
      for (const replaySource of ["assistant", "confirmed"] as const) {
        const s = await setup();
        const assistant = atom(
          "legacy-assistant",
          assistantTextInformationKind.kind,
          {
            text: "已经由旧版本提交的正文",
            source: target,
            originatingModuleInstanceId: activation.instanceId,
            turn: null,
          },
        );
        const confirmed = atom(
          "legacy-confirmed",
          "agent.heavy.message.content.confirmed",
          {
            assistantInformationId: assistant.informationId,
          },
          [
            {
              relation: "core:caused-by",
              informationId: assistant.informationId,
            },
          ],
        );
        const delivery = atom(
          "legacy-delivery",
          "core.delivery.requested",
          {
            adapterId: target.adapterId,
            platform: target.platform,
            destination: target.destination,
            message: { kind: "text", text: "已经由旧版本提交的正文" },
            turn: null,
          },
          [
            {
              relation: "core:caused-by",
              informationId:
                legacyCause === "assistant"
                  ? assistant.informationId
                  : confirmed.informationId,
            },
          ],
        );
        // 旧因果边位于第二页；终态存在与否都不能让升级生成第二份输出。
        const noise = Array.from({ length: 1000 }, (_, i) =>
          atom(`legacy-noise-${i}`, "test.legacy.audit", {}, [
            {
              relation: "core:caused-by",
              informationId: assistant.informationId,
            },
          ]),
        );
        const graph = [assistant, ...noise, confirmed, delivery];
        if (status !== "pending")
          graph.push(
            atom(
              "legacy-terminal",
              status === "delivered"
                ? "core.delivery.delivered"
                : "core.delivery.failed",
              {
                ok: status === "delivered",
                ...(status === "unknown" ? { outcome: "unknown" } : {}),
              },
              [
                {
                  relation: "core:status-of",
                  informationId: delivery.informationId,
                },
              ],
            ),
          );
        const sourceAtom = replaySource === "assistant" ? assistant : confirmed;
        const related = vi.fn(
          async ({
            from,
            relation,
            direction,
            offset = 0,
            limit = 1000,
          }: any) => {
            const matches =
              direction === "incoming"
                ? graph.filter((entry) =>
                    entry.references.some(
                      (ref) =>
                        ref.relation === relation &&
                        from.includes(ref.informationId),
                    ),
                  )
                : graph.filter((entry) =>
                    graph.some(
                      (origin) =>
                        from.includes(origin.informationId) &&
                        origin.references.some(
                          (ref) =>
                            ref.relation === relation &&
                            ref.informationId === entry.informationId,
                        ),
                    ),
                  );
            return matches.slice(offset, offset + limit);
          },
        );
        const ledger = {
          related,
          find: async () => [],
          retrieve: async () => [],
        };
        vi.mocked(s.context.select).mockImplementation(async (selector) => {
          const ids = await selector.select({ sourceAtom, ledger });
          return ids.map((id) =>
            graph.find((entry) => entry.informationId === id)!,
          );
        });
        const subscription = s.instance.subscriptions.find(
          (entry) => entry.subscriptionId === `kaguya.heavy.${replaySource}`,
        )!;
        expect(subscription).toBeDefined();
        await subscription.handle(sourceAtom as never, {
          ...s.context,
          sourceAtom,
        });
        expect(related).toHaveBeenCalledWith(
          expect.objectContaining({
            from: [assistant.informationId],
            offset: 1000,
          }),
        );
        expect(s.registerOnce).not.toHaveBeenCalled();
        expect(s.execute).not.toHaveBeenCalled();
      }
    }
  },
);
