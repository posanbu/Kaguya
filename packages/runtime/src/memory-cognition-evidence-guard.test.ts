/**
 * 功能概述：验证 Mem0 旧快照的 Knowledge 来源 guard 不会放大可用来源或在错误时跳过检查。
 * 主要职责：检查撤回过滤、未投影原文保留、闭包预算及异常关闭；使用仓储替身，不调用外部认知服务。
 * 代码库关系：覆盖 runtime 命名策略；快照任一来源被撤回就整体拒绝的行为由 memory-cognition 测试验证。
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryCognitionEvidenceGuardStrategy } from "./memory-cognition-evidence-guard.js";

describe("cognition evidence availability guard", () => {
  it("returns only requested available sources in the original order", async () => {
    const filterAvailableSourceIds = vi.fn(async () => [
      "unprojected",
      "unrequested",
      "first",
    ]);
    const strategy = new MemoryCognitionEvidenceGuardStrategy({
      filterAvailableSourceIds,
    });
    const ids = await strategy.retrieve({
      input: { sourceInformationIds: ["first", "revoked", "unprojected"] },
      limit: 3,
    });
    expect(ids).toEqual(["first", "unprojected"]);
    expect(Object.isFrozen(ids)).toBe(true);
    expect(filterAvailableSourceIds).toHaveBeenCalledWith({
      sourceInformationIds: ["first", "revoked", "unprojected"],
    });
  });

  it("returns no sources when the revocation store is unavailable", async () => {
    const strategy = new MemoryCognitionEvidenceGuardStrategy({
      filterAvailableSourceIds: async () => {
        throw new Error("storage unavailable");
      },
    });
    expect(
      await strategy.retrieve({
        input: { sourceInformationIds: ["first"] },
        limit: 1,
      }),
    ).toEqual([]);
  });

  it.each([
    { sourceInformationIds: ["first", "first"], limit: 2 },
    { sourceInformationIds: ["first", "second"], limit: 1 },
    { sourceInformationIds: [], limit: 1 },
    {
      sourceInformationIds: Array.from({ length: 33 }, (_, i) => `source-${i}`),
      limit: 33,
    },
  ])(
    "rejects an invalid or incomplete closure budget before reading storage",
    async ({ sourceInformationIds, limit }) => {
      const filterAvailableSourceIds = vi.fn(async () => sourceInformationIds);
      const strategy = new MemoryCognitionEvidenceGuardStrategy({
        filterAvailableSourceIds,
      });
      expect(
        await strategy.retrieve({ input: { sourceInformationIds }, limit }),
      ).toEqual([]);
      expect(filterAvailableSourceIds).not.toHaveBeenCalled();
    },
  );
});
