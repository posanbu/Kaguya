/**
 * 功能概述：验证 MemoryRecall 到命名 Information 检索策略的安全适配。
 * 主要职责：覆盖 source ID 去重、Runtime limit 注入和仓储故障的空结果降级。
 * 代码库关系：Core 会用返回 ID 重载并授权原始 inbound；本测试不伪造 Memory atom。
 * 输入输出与副作用：使用内存替身，无数据库或日志 I/O。
 */
import type { MemoryRecall } from "@kaguya/memory";
import { describe, expect, it, vi } from "vitest";

import { MemoryInformationRetrievalStrategy } from "./memory-retrieval.js";

const document = {
  memoryId: "memory-1",
  sourceInformationId: "source-1",
  sourceKind: "core.message.inbound.text",
  content: "moonlight",
  occurredAt: "2026-09-06T00:00:00.000Z",
  createdAt: "2026-09-06T00:00:01.000Z",
  address: {
    platform: "web",
    adapterId: "web.main",
    platformMessageId: "request-1",
    accountId: "web",
    destination: { kind: "web" as const },
  },
};

describe("MemoryInformationRetrievalStrategy", () => {
  it("returns unique source Information IDs and applies the Core limit", async () => {
    const recall = vi.fn(async () => [
      { document, score: 1 },
      { document, score: 0.5 },
    ]);
    const strategy = new MemoryInformationRetrievalStrategy({ recall });

    await expect(
      strategy.retrieve({ input: { query: "moon" }, limit: 8 }),
    ).resolves.toEqual(["source-1"]);
    expect(recall).toHaveBeenCalledWith({ query: "moon", limit: 8 });
  });

  it("reports only the error type and degrades to an empty result", async () => {
    const failure = new Error("secret query and document");
    failure.name = "DatabaseUnavailableError";
    const memory: MemoryRecall = {
      recall: async () => Promise.reject(failure),
    };
    const reportFailure = vi.fn();
    const strategy = new MemoryInformationRetrievalStrategy(memory, {
      reportFailure,
    });

    await expect(
      strategy.retrieve({ input: { query: "private text" }, limit: 8 }),
    ).resolves.toEqual([]);
    expect(reportFailure).toHaveBeenCalledWith({
      errorType: "DatabaseUnavailableError",
    });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("private");
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("secret");
  });
});
