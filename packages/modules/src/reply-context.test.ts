/**
 * 功能概述：验证 reply 运行上下文只来自显式 Selector 和可追溯账本原子。
 * 主要职责：首先锁定默认 selector 仅返回当前已接受消息且不调用任何历史查询；后续
 * 同文件覆盖 reply/Memory 原子的有序 Prompt 渲染和不支持 kind 的拒绝。
 * 代码库关系：测试 modules 公共入口导出的 reply-context 能力，Engine 负责真正执行
 * Selector 与加载原子，PromptCompiler 负责生成最终 provenance。
 * 输入输出与副作用：只构造冻结原子和会在误调用时拒绝的 reader，不访问数据库或 LLM。
 */
import {
  freezeInformationAtom,
  informationIdSchema,
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
} from "@kaguya/schema";
import type { InformationSelectorDefinition } from "@kaguya/sdk";
import { PromptCompiler } from "@kaguya/prompt";
import { describe, expect, it } from "vitest";

import * as modules from "./index.js";
import {
  coreMemoryTextInformationKind,
  replyRequestedInformationKind,
} from "./information-kinds.js";

const replyAtom = freezeInformationAtom({
  informationId: informationIdSchema.parse("reply-current"),
  kind: replyRequestedInformationKind.kind,
  occurredAt: "2026-09-04T00:00:00.000Z",
  source: "module:filter",
  payload: {
    text: "hello",
    source: {
      adapterId: "adapter",
      platform: "qq",
      platformMessageId: "platform-1",
      destination: { kind: "group" as const, groupId: "group-1" },
      senderId: "sender-1",
    },
  },
  references: [],
});

const memoryAtom = freezeInformationAtom({
  informationId: informationIdSchema.parse("memory-current"),
  kind: coreMemoryTextInformationKind.kind,
  occurredAt: "2026-09-04T00:00:01.000Z",
  source: "module:memory",
  payload: { text: "likes tea" },
  references: [],
});

function compileReplyPrompt() {
  expect(modules).toHaveProperty("compileReplyPromptFromInformation");
  return (
    modules as typeof modules & {
      compileReplyPromptFromInformation(
        compiler: PromptCompiler,
        atoms: readonly DeepReadonly<InformationAtom>[],
        sourceInformationId: InformationId,
      ): CompiledPrompt;
    }
  ).compileReplyPromptFromInformation;
}

describe("reply context", () => {
  it("selects only the current accepted message without querying history", async () => {
    expect(modules).toHaveProperty("currentAcceptedMessageSelector");
    const selector = (
      modules as typeof modules & {
        currentAcceptedMessageSelector: InformationSelectorDefinition;
      }
    ).currentAcceptedMessageSelector;

    const ids = await selector.select({
      sourceAtom: replyAtom,
      ledger: {
        find: async () => Promise.reject(new Error("unexpected find")),
        related: async () => Promise.reject(new Error("unexpected related")),
        retrieve: async () => Promise.reject(new Error("unexpected retrieve")),
      },
    });

    expect(ids).toEqual([replyAtom.informationId]);
  });

  it("renders selected reply and Memory atoms in selector order", () => {
    const prompt = compileReplyPrompt()(
      new PromptCompiler(),
      [memoryAtom, replyAtom],
      replyAtom.informationId,
    );

    expect(
      prompt.fragments.map(({ informationId, source, content }) => ({
        informationId,
        source,
        content,
      })),
    ).toEqual([
      {
        informationId: memoryAtom.informationId,
        source: "memory",
        content: "likes tea",
      },
      {
        informationId: replyAtom.informationId,
        source: "history",
        content: "hello",
      },
    ]);
  });

  it("rejects a selection that omits the current reply", () => {
    expect(() =>
      compileReplyPrompt()(
        new PromptCompiler(),
        [memoryAtom],
        replyAtom.informationId,
      ),
    ).toThrow("Reply selection must include the current input");
  });

  it("rejects an atom kind without an explicit reply renderer", () => {
    const unsupported = freezeInformationAtom({
      informationId: informationIdSchema.parse("unsupported-1"),
      kind: "acme.unsupported",
      occurredAt: "2026-09-04T00:00:02.000Z",
      source: "module:test",
      payload: { text: "must not leak into Prompt" },
      references: [],
    });

    expect(() =>
      compileReplyPrompt()(
        new PromptCompiler(),
        [replyAtom, unsupported],
        replyAtom.informationId,
      ),
    ).toThrow("Unsupported reply context information kind: acme.unsupported");
  });
});
