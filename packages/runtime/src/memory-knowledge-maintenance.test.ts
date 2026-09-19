/**
 * 功能概述：验证知识记忆 bootstrap 只登记有限个可靠根任务，并保留启动顺序和失败边界。
 * 主要职责：使用 register 替身检查回填先于维护、重复维护具有独立游标起点、
 * 根登记失败不会隐式继续后续步骤；不模拟数据库页面更新或重复测试模块内的分页算法。
 * 代码库关系：直接调用 runtime 的 maintenance helper，核对与 memory-knowledge kinds 共用的协议对象。
 * 输入输出与副作用：固定时钟，无外部服务、定时扫描或真实持久化副作用。
 */
import type { InformationCore } from "@kaguya/engine";
import {
  memoryKnowledgeBackfillInformationKind,
  memoryKnowledgeMaintenanceInformationKind,
} from "@kaguya/modules";
import { describe, expect, it, vi } from "vitest";
import { createMemoryKnowledgeBootstrap } from "./memory-knowledge-maintenance.js";

function fixture() {
  const register = vi.fn<InformationCore["register"]>();
  const bootstrap = createMemoryKnowledgeBootstrap({
    core: {
      register: register as unknown as InformationCore["register"],
    },
    now: () => new Date("2026-09-19T00:00:00.000Z"),
  });
  return { bootstrap, register };
}

describe("knowledge bootstrap root tasks", () => {
  it("persists the historical root before opening a separate dirty-page scan", async () => {
    const f = fixture();
    await f.bootstrap.requestBackfill();
    expect(f.register).toHaveBeenCalledTimes(2);
    expect(f.register).toHaveBeenNthCalledWith(
      1,
      memoryKnowledgeBackfillInformationKind,
      {
        source: "runtime:memory-knowledge",
        occurredAt: "2026-09-19T00:00:00.000Z",
        payload: { afterInformationId: null },
        references: [],
      },
    );
    expect(f.register).toHaveBeenNthCalledWith(
      2,
      memoryKnowledgeMaintenanceInformationKind,
      {
        source: "runtime:memory-knowledge",
        occurredAt: "2026-09-19T00:00:00.000Z",
        payload: { after: null },
        references: [],
      },
    );
    expect(Object.isFrozen(f.bootstrap)).toBe(true);
  });

  it("gives later invalidations a fresh scan without reusing an advanced cursor", async () => {
    const f = fixture();
    await f.bootstrap.requestMaintenance();
    await f.bootstrap.requestMaintenance();
    expect(f.register).toHaveBeenCalledTimes(2);
    expect(
      f.register.mock.calls.every(
        (call) =>
          call[0].kind === memoryKnowledgeMaintenanceInformationKind.kind &&
          call[1].payload.after === null,
      ),
    ).toBe(true);
  });

  it("propagates a failed backfill registration before scheduling maintenance", async () => {
    const f = fixture();
    f.register.mockRejectedValueOnce(new Error("ledger unavailable"));
    await expect(f.bootstrap.requestBackfill()).rejects.toThrow(
      "ledger unavailable",
    );
    expect(f.register).toHaveBeenCalledTimes(1);
  });
});
