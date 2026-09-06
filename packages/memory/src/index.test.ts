/**
 * 功能概述：验证 Memory 公共输入边界与 Unicode 稀疏归一的确定性。
 * 主要职责：覆盖中英文、兼容字符、单字符、空白和 code-point 上限。
 * 代码库关系：数据库与 Runtime 测试依赖这里固定的 gram 和 schema 语义。
 * 输入输出与副作用：纯单元测试，不访问数据库或网络。
 */
import { describe, expect, it } from "vitest";

import {
  InvalidMemoryInputError,
  MEMORY_MAX_CONTENT_CODE_POINTS,
  MEMORY_MAX_QUERY_CODE_POINTS,
  memorySparseDocumentGrams,
  memorySparseGrams,
  parseMemoryDocumentInput,
  parseMemoryRecallQuery,
} from "./index.js";

describe("memory sparse normalization", () => {
  it("normalizes compatibility forms, case, whitespace, and Unicode pairs", () => {
    expect(memorySparseGrams("Ａ B 月亮")).toEqual(["ab", "b月", "月亮"]);
    expect(memorySparseGrams("🌕月")).toEqual(["🌕月"]);
    expect(memorySparseGrams("月")).toEqual(["月"]);
    expect(memorySparseGrams("  \n ")).toEqual([]);
    expect(memorySparseDocumentGrams("月亮")).toEqual(["月亮", "月", "亮"]);
  });
});

describe("memory input validation", () => {
  const document = {
    sourceInformationId: "source-1",
    sourceKind: "core.message.inbound.text",
    content: "I like moonlight",
    occurredAt: "2026-09-06T00:00:00.000Z",
    address: {
      platform: "qq",
      adapterId: "qq.main",
      platformMessageId: "message-1",
      accountId: "account-1",
      destination: { kind: "group", groupId: "group-1" },
    },
  } as const;

  it("freezes accepted documents and permits an unfiltered global query", () => {
    const parsed = parseMemoryDocumentInput(document);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.address.destination)).toBe(true);
    expect(parseMemoryRecallQuery({ query: "moon", limit: 8 })).toEqual({
      query: "moon",
      limit: 8,
    });
  });

  it("rejects blank and oversized content", () => {
    expect(() =>
      parseMemoryDocumentInput({ ...document, content: " " }),
    ).toThrow(InvalidMemoryInputError);
    expect(() =>
      parseMemoryDocumentInput({
        ...document,
        content: "月".repeat(MEMORY_MAX_CONTENT_CODE_POINTS + 1),
      }),
    ).toThrow(InvalidMemoryInputError);
    expect(() =>
      parseMemoryRecallQuery({
        query: "月".repeat(MEMORY_MAX_QUERY_CODE_POINTS + 1),
        limit: 8,
      }),
    ).toThrow(InvalidMemoryInputError);
  });
});
