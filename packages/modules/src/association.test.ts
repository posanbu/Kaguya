/**
 * 功能概述：验证 #72 的可追溯联想链只通过 Information DAG 暴露召回结果。
 * 主要职责：锁定 association request/query/candidate/completed 四类 kind、确定性
 * sparse-2gram 路线，以及 candidate 只保存 canonical source informationId 的契约。
 * 代码库关系：直接消费 `association.ts` 与 `information-kinds.ts`；Engine 负责 Selector
 * 的授权重载，Runtime 负责注入实际 retrieval strategy，reply 模块消费 completed terminal。
 * 输入输出与副作用：测试只构造冻结的模块定义和内存 Selector；不访问数据库、模型或平台，
 * 并明确禁止把 source 正文复制进 candidate receipt。
 */
import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";
import { describe, expect, it, vi } from "vitest";

import {
  associationModule,
  associationCandidateSelector,
} from "./association.js";
import {
  associationCandidateInformationKind,
  associationCompletedInformationKind,
  associationQueryInformationKind,
  associationRequestedInformationKind,
  coreMemoryTextInformationKind,
  inboundTextInformationKind,
  replyRequestedInformationKind,
  turnContextCompletedInformationKind,
} from "./information-kinds.js";

describe("associationModule", () => {
  it("declares the auditable request/query/candidate/completed chain", () => {
    expect(associationModule.manifest.consumes.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["core.reply.requested"]),
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

  it("recalls globally before the current inbound and excludes the inbound itself", async () => {
    const query = freezeInformationAtom({
      informationId: informationIdSchema.parse("association-query-1"),
      kind: associationQueryInformationKind.kind,
      occurredAt: "2026-09-04T00:00:01.000Z",
      source: "module:association.default",
      payload: {
        requestInformationId: "association-request-1",
        sourceInformationId: "reply-current",
        queryText: "hello",
        query: "hello",
        asOf: "2026-09-04T00:00:01.000Z",
        route: "reply",
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
    const reply = atom(
      "reply-current",
      replyRequestedInformationKind.kind,
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
      .mockResolvedValueOnce([reply])
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
        occurredBefore: currentInbound.occurredAt,
        excludeSourceInformationIds: [currentInbound.informationId],
      },
      limit: 8,
    });
  });
});
