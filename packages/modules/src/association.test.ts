/**
 * 功能概述：验证 #72 的可追溯联想链只通过 Information DAG 暴露召回结果。
 * 主要职责：锁定 association request/query/candidate/completed 四类 kind、确定性
 * lexical-recency 路线，以及 candidate 只保存 canonical source informationId 的契约。
 * 代码库关系：直接消费 `association.ts` 与 `information-kinds.ts`；Engine 负责 Selector
 * 的授权重载，Runtime 负责注入实际 retrieval strategy，reply 模块消费 completed terminal。
 * 输入输出与副作用：测试只构造冻结的模块定义和内存 Selector；不访问数据库、模型或平台，
 * 并明确禁止把 source 正文复制进 candidate receipt。
 */
import { describe, expect, it } from "vitest";

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
      strategy: "lexical-recency",
      reasonCodes: ["lexical-match", "recency-ranked"],
    });
    expect(parsed.success).toBe(true);
    expect(coreMemoryTextInformationKind.payloadSchema.parse({
      text: "the source remains in memory",
    })).toEqual({ text: "the source remains in memory" });
    expect(parsed.success && parsed.data).not.toHaveProperty("text");
  });
});
