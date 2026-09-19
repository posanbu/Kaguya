/**
 * 功能概述：同步验证一方模块日志投影中的真实正文、敏感内容边界和表达习惯摘要。
 * 主要职责：project 通过真实 kind schema 构造原子后调用声明的摘要或 detail 投影；
 * 测试覆盖记忆、联想查询、人物事实与表达习惯，不从模型原始响应拼造领域内容。
 * 代码库关系：直接消费 kinds 中的定义及 shared.contentPreview，与 Logger 的既有
 * debug detail 门控协作；断言 info 级人物摘要不含正文，detail 保留 content 敏感性标记。
 * 输入输出与副作用：只使用内存样例和同步投影，不初始化数据库、执行订阅或请求模型；
 * 截断边界用例锁定先完整脱敏、原文字数统计、Unicode 码点和控制字符处理。
 */
import type { InformationAtom, JsonObject } from "@kaguya/schema";
import type { InformationKindDefinition } from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

import {
  expressionLearned,
  expressionSelected,
  type Habit,
} from "./expression/facts.js";
import { associationQueryInformationKind } from "./kinds/association.js";
import { coreMemoryTextInformationKind } from "./kinds/message.js";
import {
  personFactCandidateInformationKind,
  personFactExtractedInformationKind,
} from "./kinds/person-fact.js";
import { contentPreview } from "./kinds/shared.js";

function project<K extends string, P extends JsonObject>(
  definition: InformationKindDefinition<K, P>,
  payload: unknown,
  detail = false,
): JsonObject {
  if (!definition.log.enabled) throw new Error("Expected enabled log policy");
  const atom: InformationAtom<K, P> = {
    informationId: "projection-test",
    kind: definition.kind,
    occurredAt: "2026-09-19T00:00:00.000Z",
    source: "module:projection-test",
    payload: definition.payloadSchema.parse(payload),
    references: [],
  };
  if (!detail) return definition.log.project(atom);
  if (!definition.log.detail) throw new Error("Expected content detail");
  return definition.log.detail.project(atom);
}

describe("contentPreview safety boundaries", () => {
  it.each([
    ["token=secret-value", "token=[REDACTED]"],
    ["Bearer bearer-secret-value", "Bearer [REDACTED]"],
    ["Authorization: Bearer private-bearer-probe", "Authorization=[REDACTED]"],
    ["authorization=Basic cHJpdmF0ZS1wcm9iZQ==", "authorization=[REDACTED]"],
    ["sk-private-secret-value", "[REDACTED]"],
    ["postgres://user:pass@host/db", "[REDACTED]"],
  ])(
    "redacts the complete %s before creating its preview",
    (text, expected) => {
      expect(contentPreview(text)).toEqual({
        contentPreview: expected,
        contentLength: Array.from(text).length,
        contentTruncated: false,
      });
    },
  );

  it("redacts a private material block whose closing marker is beyond the preview", () => {
    const text = `记忆内容\n-----BEGIN PRIVATE KEY-----\n${"private-material-probe".repeat(20)}\n-----END PRIVATE KEY-----\n结束`;
    const preview = contentPreview(text);
    expect(preview).toEqual({
      contentPreview: "记忆内容\n[REDACTED PRIVATE MATERIAL]\n结束…",
      contentLength: Array.from(text).length,
      contentTruncated: true,
    });
    expect(preview.contentPreview).not.toContain("private-material-probe");
  });

  it("does not reveal a token prefix split by the 168-code-point boundary", () => {
    const text = `${"安".repeat(163)} sk-private-secret-value`;
    const preview = contentPreview(text);
    expect(preview.contentPreview).toBe(`${"安".repeat(163)} [RED…`);
    expect(preview.contentPreview).not.toContain("sk-");
    expect(preview.contentLength).toBe(Array.from(text).length);
    expect(preview.contentTruncated).toBe(true);
  });

  it("marks truncation when redaction placeholders expand a short original", () => {
    const text = `${"明".repeat(156)} token=x`;
    const preview = contentPreview(text);
    expect(preview.contentLength).toBe(164);
    expect(preview.contentTruncated).toBe(true);
    expect(Array.from(preview.contentPreview)).toHaveLength(169);
    expect(preview.contentPreview).not.toContain("token=x");
  });

  it("counts Unicode code points and preserves a complete emoji at the boundary", () => {
    expect(contentPreview(`${"字".repeat(167)}😀尾`)).toEqual({
      contentPreview: `${"字".repeat(167)}😀…`,
      contentLength: 169,
      contentTruncated: true,
    });
    expect(contentPreview(`${"字".repeat(167)}😀`)).toEqual({
      contentPreview: `${"字".repeat(167)}😀`,
      contentLength: 168,
      contentTruncated: false,
    });
  });

  it("preserves line structure while escaping terminal control bytes", () => {
    expect(contentPreview("第一行\n第二行\t\u0000\u001b[31m")).toEqual({
      contentPreview: "第一行\n第二行\t\\u0000\\u001b[31m",
      contentLength: 14,
      contentTruncated: false,
    });
  });
});

describe("first-party content projections", () => {
  it("projects real memory text at its existing debug level without mutating the payload", () => {
    const payload = {
      text: "用户喜欢古典音乐 token=memory-secret\nAuthorization: Bearer memory-bearer-secret",
    };
    const original = structuredClone(payload);
    expect(coreMemoryTextInformationKind.log).toMatchObject({
      enabled: true,
      level: "debug",
    });
    expect(project(coreMemoryTextInformationKind, payload)).toEqual({
      event: "memory.text.registered",
      contentPreview:
        "用户喜欢古典音乐 token=[REDACTED]\nAuthorization=[REDACTED]",
      contentLength: Array.from(payload.text).length,
      contentTruncated: false,
    });
    expect(payload).toEqual(original);
  });

  it("shows the actual association query without substituting the original input", () => {
    const query = "古典 音乐 token=query-secret";
    expect(associationQueryInformationKind.log).toMatchObject({
      enabled: true,
      level: "debug",
    });
    expect(
      project(associationQueryInformationKind, {
        requestInformationId: "request-1",
        sourceInformationId: "source-1",
        queryText: "原始用户输入不应替代实际查询",
        query,
        asOf: "2026-09-19T00:00:00.000Z",
        route: "message",
        method: "sparse-2gram",
        identity: { status: "unresolved" },
        scope: {
          platform: "qq",
          adapterId: "onebot.main",
          destination: { kind: "group", groupId: "group-1" },
        },
        limit: 8,
      }),
    ).toEqual({
      event: "association.query",
      route: "message",
      method: "sparse-2gram",
      queryLength: Array.from(query).length,
      limit: 8,
      contentPreview: "古典 音乐 token=[REDACTED]",
      contentLength: Array.from(query).length,
      contentTruncated: false,
    });
  });

  it("projects person-fact input at debug without exposing person identifiers", () => {
    expect(personFactCandidateInformationKind.log).toMatchObject({
      enabled: true,
      level: "debug",
    });
    expect(
      project(personFactCandidateInformationKind, {
        personId: "private-person-id",
        name: "private-person-name",
        text: "我喜欢喝茶 token=candidate-secret",
      }),
    ).toEqual({
      event: "person.fact.candidate",
      contentPreview: "我喜欢喝茶 token=[REDACTED]",
      contentLength: Array.from("我喜欢喝茶 token=candidate-secret").length,
      contentTruncated: false,
    });
  });

  it("keeps info-level person facts content-free and marks debug detail as content", () => {
    const payload = {
      personId: "private-person-id",
      name: "private-person-name",
      fact: "用户喜欢喝茶 token=fact-secret",
    };
    expect(personFactExtractedInformationKind.log).toMatchObject({
      enabled: true,
      level: "info",
      detail: { sensitivity: "content" },
    });
    expect(project(personFactExtractedInformationKind, payload)).toEqual({
      event: "person.fact.extracted",
    });
    expect(project(personFactExtractedInformationKind, payload, true)).toEqual({
      event: "person.fact.extracted",
      contentPreview: "用户喜欢喝茶 token=[REDACTED]",
      contentLength: Array.from(payload.fact).length,
      contentTruncated: false,
    });
  });
});

describe("expression summaries", () => {
  const habit: Habit = {
    habitId: "private-habit-id",
    scopeInformationId: "private-scope-id",
    situation: "表达疑惑",
    style: "短句直说",
    sourceInformationIds: ["private-source-id"],
    occurrences: 2,
    reviewStatus: "validated",
    version: 1,
  };

  it("projects only learned situation and style enums with the existing status and count", () => {
    expect(expressionLearned.log).toMatchObject({
      enabled: true,
      level: "debug",
    });
    expect(
      project(expressionLearned, {
        scopeInformationId: habit.scopeInformationId,
        status: "completed",
        reason: "validated",
        habits: [habit],
        version: 1,
      }),
    ).toEqual({
      event: "expression.learned",
      status: "completed",
      count: 1,
      habitSummaries: ["表达疑惑 → 短句直说"],
    });
  });

  it("retains the actual selection reason and enum summary without copying habit IDs", () => {
    expect(expressionSelected.log).toMatchObject({
      enabled: true,
      level: "debug",
    });
    expect(
      project(expressionSelected, {
        intentInformationId: "intent-1",
        scopeInformationId: habit.scopeInformationId,
        habitIds: [habit.habitId],
        habits: [habit],
        reason: "selected",
        version: 1,
      }),
    ).toEqual({
      event: "expression.selected",
      count: 1,
      reason: "selected",
      habitSummaries: ["表达疑惑 → 短句直说"],
    });
  });

  it("keeps an empty selection empty", () => {
    expect(
      project(expressionSelected, {
        intentInformationId: "intent-1",
        scopeInformationId: null,
        habitIds: [],
        habits: [],
        reason: "no-candidates",
        version: 1,
      }),
    ).toEqual({
      event: "expression.selected",
      count: 0,
      reason: "no-candidates",
      habitSummaries: [],
    });
  });
});
