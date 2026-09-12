/**
 * 功能概述：验证消息编写的严格意图契约及 intent→Model Task→assistant→纯文本投递三个阶段。
 * 主要职责：保护 modelTier 唯一配置、完整 turn Prompt、失败与取消无业务写入、完成任务 task/version/definition/tier 过滤及外部实例隔离与目标元数据最小化。
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
  messageIntentRequestedInformationPayloadSchema,
} from "../information-kinds.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import {
  createMessageComposerModule,
  messageComposerSettingsSchema,
  messageTaskOutputSchema,
  type ModelTaskRequest,
  type ModelTaskResult,
  type ModelTaskCapability,
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
      output: z.string(),
    })
    .strict(),
  references: {},
  log: { enabled: false },
});
const activation = {
  instanceId: "message-composer.default",
  definitionId: "agent.message-composer",
};
async function setup() {
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
  const definition = createMessageComposerModule({
    modelTaskCapability: token,
    modelTaskCompletedInformationKind: completedKind,
    promptTemplates: loadFirstPartyPromptTemplates().messageComposer,
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
    use: () => ({ execute, cancel: vi.fn() }),
  } as unknown as InformationModuleHandlerContext;
  const instance = await definition.create(
    {
      instanceId: activation.instanceId,
      settings: { modelTier: "heavy" },
      activation,
    },
    context,
  );
  return { f, execute, registerOnce, definition, context, instance };
}
describe("message composer", () => {
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
    expect(messageComposerSettingsSchema.parse({ modelTier: "heavy" })).toEqual(
      { modelTier: "heavy" },
    );
    for (const outbound of [
      { mode: "source", messageKind: "reply" },
      { mode: "fixed", ...target },
    ])
      expect(
        messageComposerSettingsSchema.safeParse({
          modelTier: "heavy",
          outbound,
        }).success,
      ).toBe(false);
    expect(messageTaskOutputSchema.parse(" text ")).toBe("text");
    expect(messageTaskOutputSchema.safeParse("  ").success).toBe(false);
    expect(messageTaskOutputSchema.safeParse({ text: "x" }).success).toBe(
      false,
    );
  });
  it("dispatches one text task with the complete frozen turn and canonical diagnostics", async () => {
    const s = await setup();
    expect(s.definition.manifest.definitionId).toBe("agent.message-composer");
    expect(s.definition.manifest.requires).toEqual([
      { id: "kaguya:model-task", apiVersion: 1 },
    ]);
    await s.instance.subscriptions[0]!.handle(s.f.intent as never, s.context);
    expect(s.execute).toHaveBeenCalledTimes(1);
    const request = s.execute.mock.calls[0]![0] as unknown as {
      task: { taskId: string; outputMode: string };
      prompt: { text: string };
      contextAtoms: unknown;
    };
    expect(request.task).toMatchObject({
      taskId: "agent.message.compose",
      outputMode: "text",
    });
    expect(request.prompt.text).toContain("FIRST_INPUT");
    expect(request.prompt.text).toContain("LAST_INPUT");
    expect(request.contextAtoms).toEqual(s.f.atoms);
    expect(s.context.report).toHaveBeenCalledWith(
      expect.objectContaining({ event: "message.model.dispatching" }),
      expect.objectContaining({
        taskId: "agent.message.compose",
        turnCharacters: expect.any(Number),
      }),
    );
    expect(s.registerOnce).not.toHaveBeenCalled();
  });
  it("records target-only assistant and text delivery, preserving turn without reply markers", async () => {
    const s = await setup();
    const completed = atom("completed-1", completedKind.kind, {
      taskId: "agent.message.compose",
      version: "1",
      sourceInformationId: s.f.intent.informationId,
      activation: { ...activation, instanceId: "another-instance" },
      selectionPolicy: { tier: "heavy" },
      output: " COMPOSED ",
    });
    await s.instance.subscriptions[1]!.handle(completed as never, s.context);
    expect(s.registerOnce).toHaveBeenCalledWith(
      "kaguya.message.assistant.v1",
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
    await s.instance.subscriptions[2]!.handle(assistant as never, s.context);
    expect(s.registerOnce).toHaveBeenLastCalledWith(
      "kaguya.message.delivery.v1",
      `${activation.instanceId}:assistant-1`,
      expect.anything(),
      {
        payload: {
          ...target,
          message: { kind: "text", text: "COMPOSED" },
          turn: s.f.intent.payload.turn,
        },
        references: [
          { relation: "agent:turn-claim", informationId: "claim-1" },
          { relation: "agent:turn-candidate", informationId: "candidate-1" },
        ],
      },
    );
  });
  it("ignores foreign task definitions and model tiers before selecting context", async () => {
    const s = await setup();
    for (const override of [
      { taskId: "foreign.task" },
      { taskId: "core.reply.generate" },
      { version: "2" },
      { selectionPolicy: { tier: "light" } },
      { activation: { ...activation, definitionId: "foreign.module" } },
    ]) {
      const completed = atom("completed-1", completedKind.kind, {
        taskId: "agent.message.compose",
        version: "1",
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
    (entry) => entry.selectorId === "kaguya.message.completed-source",
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
  ).resolves.toEqual([s.f.intent.informationId]);
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
      originatingModuleInstanceId: "message-composer.other",
      turn: messageIntentRequestedInformationPayloadSchema.parse(
        s.f.intent.payload,
      ).turn,
    },
  );
  await s.instance.subscriptions[2]!.handle(assistant as never, s.context);
  expect(s.context.select).not.toHaveBeenCalled();
  expect(s.registerOnce).not.toHaveBeenCalled();
});
