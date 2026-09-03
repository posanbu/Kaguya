/**
 * 功能概述：本文件验证演示信息模块在接收文本输入后注册 filter decision 原子。
 * 主要职责：构造冻结的入站 atom 与解析后的设置，调用模块订阅处理器，并断言其以
 * `InformationModuleHandlerContext.register` 提交原有的 decision payload。
 * 代码库关系：覆盖 `always-reply-information-filter.ts`，并使用
 * `information-kinds.ts` 的输入和输出 definition；该模块由后续 Runtime 组合。
 * 输入输出与副作用：只使用 Vitest mock 和内存 atom，不访问 Core 或账本；测试保持
 * 过滤器的既有 shouldReply、reason、targetInstanceId 业务语义不变。
 */
import { freezeInformationAtom, informationIdSchema, z } from "@kaguya/schema";
import { describe, expect, it, vi } from "vitest";

import { alwaysReplyInformationFilterModule } from "./always-reply-information-filter.js";
import {
  filterDecisionInformationKind,
  inboundTextInformationKind,
} from "./information-kinds.js";

describe("always reply information filter", () => {
  it("declares the input and decision kinds and registers a decision", async () => {
    const definition = alwaysReplyInformationFilterModule;
    const settings = definition.manifest.settingsSchema.parse({
      replyTargetInstanceId: "reply-1",
    });
    const instance = await definition.create({
      instanceId: "filter-1",
      settings,
    });
    const atom = freezeInformationAtom({
      informationId: informationIdSchema.parse("inbound-1"),
      kind: inboundTextInformationKind.kind,
      occurredAt: "2026-09-03T00:00:00.000Z",
      source: "adapter:test",
      payload: {
        text: "hello",
        source: {
          adapterId: "adapter",
          platform: "web",
          platformMessageId: "request-1",
          destination: { kind: "web" },
          senderId: "web",
        },
      },
      references: [
        { relation: "core:context", informationId: informationIdSchema.parse("context-1") },
      ],
    });
    const register = vi.fn();
    const subscription = instance.subscriptions[0];
    expect(subscription?.kind).toBe(inboundTextInformationKind.kind);
    await subscription?.handle(atom, {
      definitionId: definition.manifest.definitionId,
      instanceId: "filter-1",
      sourceAtom: atom,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      register,
    });

    expect(register).toHaveBeenCalledWith(filterDecisionInformationKind, {
      payload: {
        shouldReply: true,
        reason: "always-reply",
        targetInstanceId: "reply-1",
      },
    });
  });
});
