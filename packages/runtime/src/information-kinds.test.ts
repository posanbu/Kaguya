/**
 * 功能概述：锁定 Runtime 信息 DAG 的完整内建 kind 集合、唯一对象所有权和关键引用契约。
 * 主要职责：验证 context、Engine 消费失败、modules 消息/过滤/投递请求、Runtime LLM 与投递
 * 结果 definition 各出现一次，并检查 Runtime 聚合复用上游导出的原始对象；requested prompt
 * 接受 canonical JSON metadata。
 * 代码库关系：直接约束 `information-kinds.ts` composition 输出；`KaguyaRuntime.start()` 会按
 * 此集合注册 Registry，ModuleHost 和 lifecycle/delivery consumer 必须使用同一 definition 身份。
 * 输入输出与副作用：纯内存检查 schema、引用规则和日志投影；不会启动 Core 或连接数据库。
 */
import { consumerFailedInformationKind } from "@kaguya/engine";
import {
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
  filterDecisionInformationKind,
  inboundTextInformationKind,
  replyRequestedInformationKind,
} from "@kaguya/modules";
import { describe, expect, it } from "vitest";

import {
  builtInInformationKinds,
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
  llmCompletedInformationKind,
  llmFailedInformationKind,
  llmRequestedInformationKind,
  runtimeContextInformationKind,
} from "./information-kinds.js";

describe("runtime information kinds", () => {
  it("accepts canonical prompt fragment metadata", () => {
    const parsed = llmRequestedInformationKind.payloadSchema.parse({
      kind: "reply",
      modelId: "model-heavy",
      workflowId: "message-module-pipeline",
      nodeId: "reply",
      originatingModuleInstanceId: "reply.one",
      prompt: {
        kind: "reply",
        text: "hello",
        fragments: [
          {
            id: "template-1",
            source: "template",
            priority: 10,
            content: "hello",
            metadata: { version: 2 },
          },
        ],
        provenance: [
          {
            fragmentId: "template-1",
            source: "template",
            priority: 10,
            contentDigest: "sha256:template-1",
          },
        ],
      },
    });

    expect(parsed.prompt.fragments[0]?.metadata).toEqual({ version: 2 });
  });

  it("aggregates every owned definition exactly once", () => {
    expect(builtInInformationKinds.map(({ kind }) => kind)).toEqual([
      "core.runtime.context",
      "consumer.failed",
      "core.message.inbound.text",
      "core.reply.requested",
      "filter.decision",
      "core.message.assistant.text",
      "core.delivery.requested",
      "core.llm.requested",
      "core.llm.completed",
      "core.llm.failed",
      "core.delivery.delivered",
      "core.delivery.failed",
    ]);
    expect(new Set(builtInInformationKinds.map(({ kind }) => kind)).size).toBe(
      builtInInformationKinds.length,
    );
  });

  it("reuses the Engine and modules definition objects", () => {
    for (const definition of [
      consumerFailedInformationKind,
      inboundTextInformationKind,
      replyRequestedInformationKind,
      filterDecisionInformationKind,
      assistantTextInformationKind,
      deliveryRequestedInformationKind,
    ]) {
      expect(builtInInformationKinds).toContain(definition);
    }
  });

  it("defines direct lifecycle and delivery status links", () => {
    expect(runtimeContextInformationKind.references).toEqual({});
    expect(llmRequestedInformationKind.references).toMatchObject({
      "core:caused-by": {
        required: true,
        multiple: false,
        targetKinds: [replyRequestedInformationKind.kind],
      },
      "core:context": { required: true, multiple: false },
    });
    for (const definition of [
      llmCompletedInformationKind,
      llmFailedInformationKind,
    ]) {
      expect(definition.references).toMatchObject({
        "core:caused-by": {
          required: true,
          multiple: false,
          targetKinds: [llmRequestedInformationKind.kind],
        },
        "core:status-of": {
          required: true,
          multiple: false,
          targetKinds: [llmRequestedInformationKind.kind],
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
