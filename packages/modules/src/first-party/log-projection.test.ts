/**
 * 功能概述：同步验证一方模块日志投影中的真实正文、敏感内容边界和表达习惯摘要。
 * 主要职责：project 通过真实 kind schema 构造原子后调用声明的摘要或 detail 投影；
 * 测试覆盖记忆、联想查询、人物事实与表达习惯，不从模型原始响应拼造领域内容。
 * 代码库关系：直接消费 kinds 中的定义及 shared.contentPreview，与 Logger 的既有
 * debug detail 门控协作；断言 info 级人物摘要不含正文，detail 保留 content 敏感性标记。
 * 输入输出与副作用：只使用内存样例和同步投影，不初始化数据库、执行订阅或请求模型；
 * 截断边界用例锁定先完整脱敏、原文字数统计、Unicode 码点和控制字符处理。
 */
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
