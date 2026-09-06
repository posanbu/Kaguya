/**
 * 功能概述：验证 scheduler 的持久化 one-shot 公共契约、时间规范化与 Core 代理边界。
 * 主要职责：确认 capability/kind 导出稳定，并确保客户端拒绝非绝对 deadline 后再调用 Core。
 * 代码库关系：仅依赖 scheduler 公共入口和 schema/SDK 契约；不触碰数据库、timer 或 Runtime。
 * 输入输出与副作用：使用内存 fake Core 记录调用；校验失败必须在任何持久化操作前抛出。
 */
import { describe, expect, it, vi } from "vitest";

import {
  OneShotScheduleClient,
  oneShotScheduleCapability,
} from "./index.js";

const request = {
  operationKey: "reminder:1",
  sourceInformationId: "info-1",
  dueAt: "2026-09-06T12:00:00.000Z",
  input: { text: "hello" },
  activation: { instanceId: "instance-1", definitionId: "module-1" },
} as const;

describe("OneShotScheduleClient", () => {
  it("publishes the v1 one-shot capability and rejects relative or timezone-free deadlines", async () => {
    expect(oneShotScheduleCapability).toMatchObject({
      id: "kaguya:schedule.one-shot",
      apiVersion: 1,
    });
    const core = { scheduleOneShot: vi.fn() };
    const client = new OneShotScheduleClient(core as never);
    await expect(
      client.schedule({ ...request, dueAt: "2026-09-06T12:00:00" }),
    ).rejects.toThrow(/absolute dueAt/);
    expect(core.scheduleOneShot).not.toHaveBeenCalled();
  });
});
