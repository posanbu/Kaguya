/**
 * 功能概述：验证 reply 运行上下文只来自显式 Selector 和可追溯账本原子。
 * 主要职责：覆盖当前消息选择、冻结 turn 的同会话历史、已投递 assistant、Memory，
 * 以及 Prompt provenance、预算和不支持 kind 的拒绝。
 * 代码库关系：测试 modules 公共入口导出的 reply-context 能力，Engine 负责真正执行
 * Selector 与加载原子，模块模板负责生成最终 variable provenance。
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
import { describe, expect, it } from "vitest";

import * as modules from "../../index.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import {
  coreMemoryTextInformationKind,
  inboundTextInformationKind,
  replyRequestedInformationKind,
} from "../information-kinds.js";

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

const historicalInboundAtom = freezeInformationAtom({
  informationId: informationIdSchema.parse("inbound-history"),
  kind: inboundTextInformationKind.kind,
  occurredAt: "2026-09-03T00:00:00.000Z",
  source: "runtime:ingress",
  payload: {
    text: "previous hello",
    source: {
      adapterId: "adapter",
      platform: "qq",
      platformMessageId: "platform-history",
      destination: { kind: "group" as const, groupId: "group-1" },
      senderId: "sender-1",
    },
  },
  references: [],
});
const replyTemplate = loadFirstPartyPromptTemplates().llmReply;
const identity = { name: "Kaguya", aliases: ["辉夜"], persona: "test" };

function compileReplyPrompt() {
  expect(modules).toHaveProperty("compileReplyPromptFromInformation");
  return (
    modules as typeof modules & {
      compileReplyPromptFromInformation(
        template: typeof replyTemplate,
        agentIdentity: typeof identity,
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
      replyTemplate,
      identity,
      [memoryAtom, replyAtom],
      replyAtom.informationId,
    );

    expect(
      prompt.variables
        .filter(({ informationIds }) => informationIds.length > 0)
        .map(({ name, informationIds, content }) => ({
          name,
          informationIds,
          content,
        })),
    ).toEqual([
      {
        name: "self_account",
        informationIds: [replyAtom.informationId],
        content: "",
      },
      {
        name: "scene",
        informationIds: [replyAtom.informationId],
        content: expect.any(String),
      },
      {
        name: "memory",
        informationIds: [memoryAtom.informationId],
        content: expect.stringContaining("likes tea"),
      },
      {
        name: "target",
        informationIds: [replyAtom.informationId],
        content: expect.stringContaining("内容：hello"),
      },
    ]);
  });

  it("renders recalled inbound provenance as Memory before the current message", () => {
    const prompt = compileReplyPrompt()(
      replyTemplate,
      identity,
      [replyAtom, historicalInboundAtom],
      replyAtom.informationId,
    );

    expect(
      prompt.variables
        .filter(({ informationIds }) => informationIds.length > 0)
        .map(({ name, informationIds }) => ({ name, informationIds })),
    ).toEqual([
      { name: "self_account", informationIds: [replyAtom.informationId] },
      { name: "scene", informationIds: [replyAtom.informationId] },
      {
        name: "history",
        informationIds: [historicalInboundAtom.informationId],
      },
      { name: "target", informationIds: [replyAtom.informationId] },
    ]);
    expect(
      prompt.variables.find(({ name }) => name === "history")!.content,
    ).toContain("previous hello");
  });

  it("limits recalled Memory to 4,000 Unicode characters", () => {
    const oversizedMemory = freezeInformationAtom({
      informationId: informationIdSchema.parse("inbound-oversized"),
      kind: coreMemoryTextInformationKind.kind,
      occurredAt: "2026-09-03T00:00:00.000Z",
      source: "runtime:ingress",
      payload: { text: "月".repeat(5_000) },
      references: [],
    });
    const prompt = compileReplyPrompt()(
      replyTemplate,
      identity,
      [oversizedMemory, replyAtom],
      replyAtom.informationId,
    );

    const memory = prompt.variables.find(({ name }) => name === "memory")!;
    expect(Array.from(memory.content).length).toBeLessThanOrEqual(4_002);
    expect(memory.content).toContain("…");
    expect(
      prompt.variables.find(({ name }) => name === "target")!.content,
    ).toContain("内容：hello");
  });

  it("rejects a selection that omits the current reply", () => {
    expect(() =>
      compileReplyPrompt()(
        replyTemplate,
        identity,
        [memoryAtom],
        replyAtom.informationId,
      ),
    ).toThrow("Reply selection must include the current input");
  });

  it("ignores an unreferenced atom kind without leaking it into the Prompt", () => {
    const unsupported = freezeInformationAtom({
      informationId: informationIdSchema.parse("unsupported-1"),
      kind: "acme.unsupported",
      occurredAt: "2026-09-04T00:00:02.000Z",
      source: "module:test",
      payload: { text: "must not leak into Prompt" },
      references: [],
    });

    const prompt = compileReplyPrompt()(
      replyTemplate,
      identity,
      [replyAtom, unsupported],
      replyAtom.informationId,
    );
    expect(prompt.text).not.toContain("must not leak");
    expect(
      prompt.variables.flatMap(({ informationIds }) => informationIds),
    ).not.toContain(unsupported.informationId);
  });

  it("selects same-scope history, excludes the target input, and keeps only delivered assistant messages", async () => {
    const source = freezeInformationAtom({
      informationId: replyAtom.informationId,
      kind: replyAtom.kind,
      occurredAt: replyAtom.occurredAt,
      source: replyAtom.source,
      payload: replyAtom.payload,
      references: [
        {
          relation: "core:uses-context",
          informationId: informationIdSchema.parse("turn-1"),
        },
      ],
    });
    const immediate = freezeInformationAtom({
      informationId: informationIdSchema.parse("inbound-immediate"),
      kind: historicalInboundAtom.kind,
      occurredAt: "2026-09-03T00:00:01.000Z",
      source: historicalInboundAtom.source,
      payload: historicalInboundAtom.payload,
      references: [],
    });
    const target = freezeInformationAtom({
      informationId: informationIdSchema.parse("inbound-target"),
      kind: historicalInboundAtom.kind,
      occurredAt: "2026-09-03T00:00:02.000Z",
      source: historicalInboundAtom.source,
      payload: historicalInboundAtom.payload,
      references: [],
    });
    const assistant = (id: string, occurredAt: string) =>
      freezeInformationAtom({
        informationId: informationIdSchema.parse(id),
        kind: "core.message.assistant.text",
        occurredAt,
        source: "module:reply",
        payload: {
          text: id,
          source: (replyAtom.payload as any).source,
          originatingModuleInstanceId: "reply.default",
          turn: null,
        },
        references: [],
      });
    const deliveredAssistant = assistant(
      "assistant-delivered",
      "2026-09-03T00:00:03.000Z",
    );
    const failedAssistant = assistant(
      "assistant-failed",
      "2026-09-03T00:00:04.000Z",
    );
    const turn = freezeInformationAtom({
      informationId: informationIdSchema.parse("turn-1"),
      kind: "agent.turn.context.completed",
      occurredAt: "2026-09-03T00:00:05.000Z",
      source: "module:heartflow",
      payload: {
        inputs: [
          { informationId: immediate.informationId },
          { informationId: target.informationId },
        ],
        memory: [memoryAtom.informationId],
      },
      references: [],
    });
    const deliveryRequest = freezeInformationAtom({
      informationId: informationIdSchema.parse("delivery-request"),
      kind: "core.delivery.requested",
      occurredAt: "2026-09-03T00:00:06.000Z",
      source: "module:reply",
      payload: {},
      references: [],
    });
    const deliveryTerminal = freezeInformationAtom({
      informationId: informationIdSchema.parse("delivery-terminal"),
      kind: "core.delivery.delivered",
      occurredAt: "2026-09-03T00:00:07.000Z",
      source: "runtime:delivery",
      payload: {},
      references: [],
    });
    const selector = (
      modules as typeof modules & {
        turnReplyContextSelector: InformationSelectorDefinition;
      }
    ).turnReplyContextSelector;

    const ids = await selector.select({
      sourceAtom: source,
      ledger: {
        find: async () => [
          target,
          immediate,
          failedAssistant,
          deliveredAssistant,
        ],
        retrieve: async () => [],
        related: async ({ from, relation, direction }) => {
          if (from[0] === source.informationId && direction === "outgoing")
            return [turn];
          if (from[0] === turn.informationId && direction === "outgoing")
            return [immediate, target, memoryAtom];
          if (
            from[0] === deliveredAssistant.informationId &&
            relation === "core:caused-by" &&
            direction === "incoming"
          )
            return [deliveryRequest];
          if (from[0] === deliveryRequest.informationId)
            return [deliveryTerminal];
          return [];
        },
      },
    });

    expect(ids).toEqual([
      immediate.informationId,
      deliveredAssistant.informationId,
      memoryAtom.informationId,
      source.informationId,
    ]);
  });
});
