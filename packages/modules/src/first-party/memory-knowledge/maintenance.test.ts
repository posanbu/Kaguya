/**
 * 功能概述：验证维护任务在终态提交失败后重试时，变化的脏页集合不会分叉成多个后继扫描。
 * 主要职责：构造两个不同游标的 50 条脏页列表，用 registerOnce 的持久赢家替身保留首次后继；
 * 在首次终态提交处注入崩溃，再重放同一请求，确认只保留一个后继且继续使用原冻结游标。
 * 代码库关系：调用 memoryKnowledgeModule 的真实 maintenance handler；页面重载返回已清理状态，
 * 模拟其他可靠 Wiki worker 在分页查询之后完成刷新，不建立 100 个真实数据库页面。
 * 输入输出与副作用：仅内存测试替身和有限 handler 调用，无数据库、计时器或外部服务。
 */
import { memoryKnowledgeCapability, type WikiPage } from "@kaguya/memory";
import type { InformationAtom, JsonObject } from "@kaguya/schema";
import type { InformationModuleHandlerContext } from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  memoryKnowledgeMaintenanceInformationKind,
  memoryKnowledgeModule,
} from "./index.js";

const occurredAt = "2026-09-19T00:00:00.000Z";
function dirtyPages(start: number): WikiPage[] {
  return Array.from({ length: 50 }, (_, index) => ({
    scopeInformationId: "scope",
    entityInformationId: `entity-${String(start + index).padStart(3, "0")}`,
    version: 1,
    dirtyVersion: 2,
    dirty: true,
    reasons: ["source_revoked"],
  }));
}

describe("maintenance successor replay", () => {
  it("keeps one successor and its original cursor when dirty pages change before retry", async () => {
    const firstPage = dirtyPages(0);
    const retryPage = dirtyPages(50);
    const listDirtyPages = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(retryPage)
      .mockResolvedValueOnce([]);
    const knowledge = {
      listDirtyPages,
      readWikiPage: vi.fn(
        async (page: {
          scopeInformationId: string;
          entityInformationId: string;
        }) => ({
          ...page,
          version: 2,
          dirtyVersion: 2,
          dirty: false,
          reasons: [],
        }),
      ),
    };
    const instance = await memoryKnowledgeModule.create(
      {
        instanceId: "knowledge",
        activation: {
          instanceId: "knowledge",
          definitionId: memoryKnowledgeModule.manifest.definitionId,
        },
        settings: {},
      },
      {
        signal: new AbortController().signal,
        now: () => new Date(occurredAt),
        report: async () => undefined,
        use: (capability) => {
          if (capability.id !== memoryKnowledgeCapability.id)
            throw new Error("Unexpected capability");
          return knowledge as never;
        },
      },
    );
    const subscription = instance.subscriptions.find(
      ({ kind }) => kind === memoryKnowledgeMaintenanceInformationKind.kind,
    )!;
    const winners = new Map<string, InformationAtom>();
    const registerOnce = vi.fn(
      async (
        operation: string,
        key: string,
        definition: { readonly kind: string },
        input: { readonly payload: JsonObject },
      ) => {
        const slot = JSON.stringify([operation, key]);
        let winner = winners.get(slot);
        if (!winner) {
          winner = {
            informationId: `successor-${winners.size + 1}`,
            kind: definition.kind,
            occurredAt,
            source: "module:knowledge",
            payload: input.payload,
            references: [],
          };
          winners.set(slot, winner);
        }
        return winner;
      },
    );
    const commitTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error("terminal response lost"))
      .mockResolvedValue(undefined);
    const context = {
      signal: new AbortController().signal,
      now: () => new Date(occurredAt),
      registerOnce,
      commitTerminal,
    } as unknown as InformationModuleHandlerContext;
    const request: InformationAtom = {
      informationId: "maintenance-root",
      kind: memoryKnowledgeMaintenanceInformationKind.kind,
      occurredAt,
      source: "runtime:memory-knowledge",
      payload: { after: null },
      references: [],
    };

    await expect(subscription.handle(request, context)).rejects.toThrow(
      "terminal response lost",
    );
    expect(winners.size).toBe(1);
    const successor = [...winners.values()][0]!;
    expect(successor.payload.after).toEqual({
      scopeInformationId: "scope",
      entityInformationId: "entity-049",
    });
    await subscription.handle(request, context);
    expect(registerOnce).toHaveBeenCalledTimes(2);
    expect(registerOnce.mock.calls.map((call) => call[1])).toEqual([
      "maintenance-root",
      "maintenance-root",
    ]);
    expect(registerOnce.mock.calls[1]![3].payload.after).toEqual({
      scopeInformationId: "scope",
      entityInformationId: "entity-099",
    });
    expect(winners.size).toBe(1);
    expect([...winners.values()][0]).toBe(successor);

    await subscription.handle(successor, context);
    expect(listDirtyPages).toHaveBeenLastCalledWith({
      limit: 50,
      after: { scopeInformationId: "scope", entityInformationId: "entity-049" },
    });
    expect(registerOnce).toHaveBeenCalledTimes(2);
    expect(commitTerminal).toHaveBeenCalledTimes(3);
  });
});
