/**
 * 检索断言包含冻结 scope，避免向量和稀疏路径跨聊天范围召回。
 * 功能概述：验证 #72 的可追溯联想链只通过 Information DAG 暴露召回结果。
 * 主要职责：锁定 association request/query/candidate/completed 四类 kind、确定性
 * sparse-2gram 路线，以及 candidate 只保存 canonical source informationId 的契约。
 * 代码库关系：直接消费 `association.ts` 与 `information-kinds.ts`；Engine 负责 Selector
 * 的授权重载，Runtime 负责注入实际 retrieval strategy，Message Composer消费 completed terminal。
 * 输入输出与副作用：测试只构造冻结的模块定义和内存 Selector；不访问数据库、模型或平台，
 * 并明确禁止把 source 正文复制进 candidate receipt。
 */
import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";
import { describe, expect, it, vi } from "vitest";

import {
  associationModule,
  associationCandidateSelector,
  associationIdentitySelector,
} from "./index.js";
import {
  associationCandidateInformationKind,
  associationCompletedInformationKind,
  associationQueryInformationKind,
  associationRequestedInformationKind,
  coreMemoryTextInformationKind,
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  turnContextCompletedInformationKind,
} from "../information-kinds.js";

describe("associationModule", () => {
  it("reloads every frozen input and builds a query in frozen order without an intent body", async () => {
    const atom = (id: string, kind: string, payload: any) =>
      freezeInformationAtom({
        informationId: informationIdSchema.parse(id),
        kind,
        payload,
        source: "module:test",
        occurredAt: "2026-09-12T00:00:00.000Z",
        references: [],
      });
    const target = {
      platform: "qq",
      adapterId: "onebot.main",
      destination: { kind: "group", groupId: "group-1" },
    };
    const first = atom("inbound-first", inboundTextInformationKind.kind, {
      text: "第一条提出问题",
      source: {
        ...target,
        senderId: "user-1",
        platformMessageId: "platform-first",
      },
    });
    const last = atom("inbound-last", inboundTextInformationKind.kind, {
      text: "第二条补充条件",
      source: {
        ...target,
        senderId: "user-2",
        platformMessageId: "platform-last",
      },
    });
    const unrelated = atom(
      "inbound-unrelated",
      inboundTextInformationKind.kind,
      {
        text: "不要进入检索",
        source: {
          ...target,
          senderId: "user-3",
          platformMessageId: "platform-other",
        },
      },
    );
    const turn = atom("turn-1", turnContextCompletedInformationKind.kind, {
      asOf: first.occurredAt,
      inputs: [
        { informationId: first.informationId },
        { informationId: last.informationId },
      ],
    });
    const intent = atom(
      "intent-1",
      messageIntentRequestedInformationKind.kind,
      {
        target,
        turn: {
          candidateInformationId: "candidate-1",
          claimInformationId: "claim-1",
          contextInformationId: turn.informationId,
        },
        memoryInformationIds: [],
      },
    );
    const related = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([turn])
      .mockResolvedValueOnce([unrelated, last, first]);
    const ids = await associationIdentitySelector.select({
      sourceAtom: intent,
      ledger: { find: async () => [], related, retrieve: async () => [] },
    });
    expect(ids).toEqual([
      last.informationId,
      first.informationId,
      turn.informationId,
    ]);
    const registerOnce = vi.fn();
    const instance = await associationModule.create(
      {
        instanceId: "association.default",
        activation: {
          instanceId: "association.default",
          definitionId: associationModule.manifest.definitionId,
        },
        settings: {},
      },
      {
        signal: new AbortController().signal,
        now: () => new Date(first.occurredAt),
        report: async () => undefined,
        use: () => {
          throw new Error("unexpected capability");
        },
      },
    );
    await instance.subscriptions[0]!.handle(intent, {
      select: async () => [last, turn, first],
      registerOnce,
    } as any);
    expect(registerOnce).toHaveBeenCalledWith(
      "kaguya.association.requested.v1",
      intent.informationId,
      associationRequestedInformationKind,
      expect.objectContaining({
        payload: expect.objectContaining({
          queryText: "第一条提出问题\n第二条补充条件",
          route: "message",
          scope: target,
        }),
      }),
    );
    expect(intent.payload).not.toHaveProperty("text");
  });

  it("declares the auditable request/query/candidate/completed chain", () => {
    expect(associationModule.manifest.consumes.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["agent.message.intent.requested"]),
    );
    expect(associationModule.manifest.produces.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        associationRequestedInformationKind.kind,
        associationQueryInformationKind.kind,
        associationCandidateInformationKind.kind,
        associationCompletedInformationKind.kind,
      ]),
    );
    expect(associationModule.manifest.selectors).toContain(
      associationCandidateSelector,
    );
  });

  it("keeps candidate receipts canonical and excludes source text", () => {
    const parsed = associationCandidateInformationKind.payloadSchema.safeParse({
      rank: 0,
      route: "memory",
      strategy: "sparse-2gram",
      reasonCodes: ["sparse-match", "coverage-ranked"],
    });
    expect(parsed.success).toBe(true);
    expect(
      coreMemoryTextInformationKind.payloadSchema.parse({
        text: "the source remains in memory",
      }),
    ).toEqual({ text: "the source remains in memory" });
    expect(parsed.success && parsed.data).not.toHaveProperty("text");
  });

  it("recalls within the frozen target scope and excludes the inbound itself", async () => {
    const query = freezeInformationAtom({
      informationId: informationIdSchema.parse("association-query-1"),
      kind: associationQueryInformationKind.kind,
      occurredAt: "2026-09-04T00:00:01.000Z",
      source: "module:association.default",
      payload: {
        requestInformationId: "association-request-1",
        sourceInformationId: "intent-current",
        queryText: "hello",
        query: "hello",
        asOf: "2026-09-04T00:00:01.000Z",
        route: "message",
        method: "sparse-2gram",
        identity: { status: "unavailable" },
        scope: {
          platform: "web",
          adapterId: "web.main",
          destination: { kind: "web" },
        },
        limit: 8,
      },
      references: [],
    });
    const atom = (informationId: string, kind: string, occurredAt: string) =>
      freezeInformationAtom({
        informationId: informationIdSchema.parse(informationId),
        kind,
        occurredAt,
        source: "module:test",
        payload: {},
        references: [],
      });
    const request = atom(
      "association-request-1",
      associationRequestedInformationKind.kind,
      query.occurredAt,
    );
    const intent = atom(
      "intent-current",
      messageIntentRequestedInformationKind.kind,
      query.occurredAt,
    );
    const turn = atom(
      "turn-current",
      turnContextCompletedInformationKind.kind,
      query.occurredAt,
    );
    const currentInbound = atom(
      "inbound-current",
      inboundTextInformationKind.kind,
      "2026-09-04T00:00:00.000Z",
    );
    const historicalInbound = atom(
      "inbound-history",
      inboundTextInformationKind.kind,
      "2026-09-03T00:00:00.000Z",
    );
    const related = vi
      .fn()
      .mockResolvedValueOnce([request])
      .mockResolvedValueOnce([intent])
      .mockResolvedValueOnce([turn])
      .mockResolvedValueOnce([currentInbound]);
    const retrieve = vi.fn().mockResolvedValue([historicalInbound]);

    await expect(
      associationCandidateSelector.select({
        sourceAtom: query,
        ledger: { find: async () => [], related, retrieve },
      }),
    ).resolves.toEqual([historicalInbound.informationId]);
    expect(retrieve).toHaveBeenCalledWith({
      strategyId: "kaguya.memory.sparse",
      input: {
        query: "hello",
        scopes: [query.payload.scope],
        occurredBefore: query.payload.asOf,
        excludeSourceInformationIds: [currentInbound.informationId],
      },
      limit: 8,
    });
  });
});
