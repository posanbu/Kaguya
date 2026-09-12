/**
 * 功能概述：锁定 Runtime 信息 DAG 的完整内建 kind 集合、唯一对象所有权和关键引用契约。
 * 主要职责：验证 context、Engine 消费失败、modules 消息/过滤/投递请求、Runtime 通用模型任务与投递
 * 结果 definition 各出现一次，并检查 Runtime 聚合复用上游导出的原始对象；通用模型任务单独注册，requested prompt
 * 接受 canonical JSON metadata，并要求有序 uses-context 引用；message intent 只允许 target、turn 与显式 memory ID 数组。
 * 代码库关系：直接约束 `information-kinds.ts` composition 输出；`KaguyaRuntime.start()` 会按
 * 此集合注册 Registry，ModuleHost 和 lifecycle/delivery consumer 必须使用同一 definition 身份。
 * 输入输出与副作用：纯内存检查 schema、引用规则和日志投影；不会启动 Core 或连接数据库。
 */
import { consumerFailedInformationKind } from "@kaguya/engine";
import {
  deliveryRequestedInformationKind,
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  messageIntentRequestedInformationPayloadSchema,
} from "@kaguya/modules";
import { describe, expect, it } from "vitest";

import {
  builtInInformationKinds,
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
  modelTaskCompletedInformationKind,
  modelTaskFailedInformationKind,
  modelTaskCancelledInformationKind,
  modelTaskRequestedInformationKind,
  runtimeContextInformationKind,
} from "./information-kinds.js";

const metadata = {
  taskId: "test.task",
  version: "1",
  outputMode: "object" as const,
  sourceInformationId: "source",
  contextInformationId: "context",
  contextInformationIds: ["source"],
  activation: { definitionId: "test.module", instanceId: "test.one" },
  selectionPolicy: { tier: "heavy" },
  resolvedModel: { providerId: "test", modelId: "model-heavy" },
  promptKind: "memory",
  promptTemplateId: "test.memory.v1",
  promptTemplateDigest: "template-digest",
  promptDigest: "prompt-digest",
  provenance: [],
};
const emptyPrompt = {
  kind: "memory" as const,
  text: "prompt",
  templateId: "test.memory.v1",
  templates: [{ name: "main", content: "prompt" }],
  variables: [],
};

describe("runtime information kinds", () => {
  it("requires the strict target, frozen turn, and explicit memory intent contract", () => {
    const payload = {
      target: {
        adapterId: "qq.main",
        platform: "qq",
        destination: { kind: "group", groupId: "42" },
      },
      turn: {
        candidateInformationId: "candidate",
        claimInformationId: "claim",
        contextInformationId: "context",
      },
      memoryInformationIds: [],
    };
    expect(messageIntentRequestedInformationKind.kind).toBe(
      "agent.message.intent.requested",
    );
    expect(messageIntentRequestedInformationKind.payloadSchema).toBe(
      messageIntentRequestedInformationPayloadSchema,
    );
    expect(
      messageIntentRequestedInformationPayloadSchema.parse(payload),
    ).toEqual(payload);
    for (const key of ["target", "turn", "memoryInformationIds"] as const) {
      const { [key]: _missing, ...incomplete } = payload;
      expect(
        messageIntentRequestedInformationPayloadSchema.safeParse(incomplete)
          .success,
      ).toBe(false);
    }
    for (const invalid of [
      { ...payload, text: "legacy" },
      { ...payload, source: payload.target },
      { ...payload, target: { ...payload.target, extra: true } },
      { ...payload, turn: { ...payload.turn, extra: true } },
      { ...payload, turn: { candidateInformationId: "candidate" } },
    ]) {
      expect(
        messageIntentRequestedInformationPayloadSchema.safeParse(invalid)
          .success,
      ).toBe(false);
    }
  });

  it("requires explicit Model Task output mode", () => {
    const parsed = modelTaskRequestedInformationKind.payloadSchema.parse({
      ...metadata,
      prompt: emptyPrompt,
    });
    expect(parsed.outputMode).toBe("object");
  });

  it("rejects missing output mode and safe-error stage", () => {
    const { outputMode: _outputMode, ...withoutOutputMode } = metadata;
    expect(
      modelTaskRequestedInformationKind.payloadSchema.safeParse({
        ...withoutOutputMode,
        prompt: emptyPrompt,
      }).success,
    ).toBe(false);
    expect(
      modelTaskFailedInformationKind.payloadSchema.safeParse({
        ...metadata,
        durationMs: 1,
        error: {
          name: "ModelTaskError",
          kind: "retryable",
          message: "Model task generation failed",
        },
      }).success,
    ).toBe(false);
  });

  it("derives canonical prompt variable provenance and digests", () => {
    const parsed = modelTaskRequestedInformationKind.payloadSchema.parse({
      ...metadata,
      prompt: {
        kind: "message",
        text: "hello",
        templateId: "test.message.v1",
        templates: [{ name: "main", content: "{{message}}" }],
        variables: [
          {
            name: "message",
            content: "hello",
            informationIds: ["source"],
          },
        ],
      },
    });

    expect(parsed.prompt.provenance[0]).toMatchObject({
      variableName: "message",
      informationIds: ["source"],
      contentDigest: expect.any(String),
    });
    expect(parsed.prompt.promptDigest).toEqual(expect.any(String));
  });

  it("rejects an invalid prompt variable name", () => {
    expect(() =>
      modelTaskRequestedInformationKind.payloadSchema.parse({
        ...metadata,
        prompt: {
          kind: "message",
          text: "hello",
          templateId: "test.message.v1",
          templates: [{ name: "main", content: "hello" }],
          variables: [
            {
              name: "Invalid Name",
              content: "hello",
              informationIds: [],
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("aggregates every owned definition exactly once", () => {
    expect(builtInInformationKinds.map(({ kind }) => kind)).toEqual([
      "core.runtime.context",
      "consumer.failed",
      "core.message.inbound.text",
      "core.delivery.requested",
      "core.delivery.delivered",
      "core.delivery.failed",
    ]);
    expect(new Set(builtInInformationKinds.map(({ kind }) => kind)).size).toBe(
      builtInInformationKinds.length,
    );
  });

  it("reuses the Engine and Runtime boundary definition objects", () => {
    for (const definition of [
      consumerFailedInformationKind,
      inboundTextInformationKind,
      deliveryRequestedInformationKind,
    ]) {
      expect(builtInInformationKinds).toContain(definition);
    }
  });

  it("defines direct lifecycle and delivery status links", () => {
    expect(runtimeContextInformationKind.references).toEqual({});
    expect(modelTaskRequestedInformationKind.references).toMatchObject({
      "core:caused-by": {
        required: true,
        multiple: false,
      },
      "core:context": { required: true, multiple: false },
      "core:uses-context": { required: true, multiple: true },
    });
    for (const definition of [
      modelTaskCompletedInformationKind,
      modelTaskFailedInformationKind,
      modelTaskCancelledInformationKind,
    ]) {
      expect(definition.references).toMatchObject({
        "core:caused-by": {
          required: true,
          multiple: false,
          targetKinds: [modelTaskRequestedInformationKind.kind],
        },
        "core:status-of": {
          required: true,
          multiple: false,
          targetKinds: [modelTaskRequestedInformationKind.kind],
        },
        "core:context": { required: true, multiple: false },
      });
    }
    for (const definition of [
      deliveryDeliveredInformationKind,
      deliveryFailedInformationKind,
    ]) {
      expect(definition.references).toMatchObject({
        "core:caused-by": {
          required: true,
          multiple: false,
          targetKinds: [deliveryRequestedInformationKind.kind],
        },
        "core:status-of": {
          required: true,
          multiple: false,
          targetKinds: [deliveryRequestedInformationKind.kind],
        },
        "core:context": { required: true, multiple: false },
      });
    }
  });
});
