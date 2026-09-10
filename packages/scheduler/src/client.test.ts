/**
 * 功能概述：验证 scheduler 的持久化 one-shot 公共契约、时间规范化与 Core 代理边界。
 * 主要职责：确认 capability/kind 导出稳定，并确保客户端拒绝非绝对 deadline 后再调用 Core。
 * 代码库关系：仅依赖 scheduler 公共入口和 schema/SDK 契约；不触碰数据库、timer 或 Runtime。
 * 输入输出与副作用：使用内存 fake Core 记录调用；校验失败必须在任何持久化操作前抛出。
 */
import { describe, expect, it, vi } from "vitest";
import { defineInformationModule } from "@kaguya/sdk";
import { z } from "@kaguya/schema";

import {
  OneShotScheduleClient,
  normalizeDueAt,
  oneShotScheduleCapability,
  oneShotRequestedInformationKind,
} from "./index.js";

const request: any = {
  operationKey: "reminder:1",
  sourceInformationId: "info-1",
  dueAt: "2026-09-06T12:00:00.000Z",
  input: { text: "hello", nested: { values: [1, { ok: true }] } },
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

  it("normalizes only strict ISO 8601 deadlines", () => {
    expect(normalizeDueAt("2026-09-06T12:00:00+08:00")).toBe(
      "2026-09-06T04:00:00.000Z",
    );
    for (const value of [
      "09/06/2026 12:00:00+08:00",
      "2026-09-06 12:00:00+08:00",
      "2026-09-06T12:00:00",
    ]) {
      expect(() => normalizeDueAt(value)).toThrow(/absolute dueAt/);
    }
  });

  it("forwards a valid schedule with normalized UTC dueAt", async () => {
    const core = {
      scheduleOneShot: vi.fn().mockResolvedValue({
        scheduleInformationId: "schedule-1",
        created: true,
      }),
    };
    const client = new OneShotScheduleClient(core as never);
    await client.schedule({ ...request, dueAt: "2026-09-06T12:00:00+08:00" });
    expect(core.scheduleOneShot).toHaveBeenCalledWith(
      expect.objectContaining({ dueAt: "2026-09-06T04:00:00.000Z" }),
    );
  });

  it("accepts nested opaque JSON and forwards replacement and finish", async () => {
    expect(oneShotRequestedInformationKind.references).toMatchObject({
      "core:caused-by": { required: true, multiple: false },
      "core:replaces": { required: false, multiple: false },
    });
    const deepInput = {
      a: { b: { c: 1 } },
      a2: [{ b: { c: 1 } }],
      a3: { b: [{ c: { d: 1 } }] },
    };
    expect(
      oneShotRequestedInformationKind.payloadSchema.parse({
        operationKey: request.operationKey,
        dueAt: request.dueAt,
        input: deepInput,
        activation: request.activation,
      }).input,
    ).toEqual(deepInput);
    expect(() =>
      oneShotRequestedInformationKind.payloadSchema.parse({
        operationKey: request.operationKey,
        dueAt: request.dueAt,
        input: { invalid: new Date() },
        activation: request.activation,
      }),
    ).toThrow();
    const core = {
      scheduleOneShot: vi.fn().mockResolvedValue({
        scheduleInformationId: "schedule-1",
        created: true,
      }),
      replaceOneShot: vi.fn().mockResolvedValue({
        scheduleInformationId: "schedule-2",
        created: true,
        previousOutcome: "superseded",
        previousTerminalInformationId: "terminal-1",
      }),
      finishOneShot: vi.fn().mockResolvedValue({
        scheduleInformationId: "schedule-2",
        terminalInformationId: "terminal-2",
        status: "fired",
        created: true,
      }),
    };
    const client = new OneShotScheduleClient(core);
    await client.replace({
      ...request,
      previousScheduleInformationId: "schedule-1",
      references: [{ relation: "core:caused-by", informationId: "info-1" }],
    });
    await client.finish({
      scheduleInformationId: "schedule-2",
      status: "fired",
    });
    expect(core.replaceOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        dueAt: request.dueAt,
        previousScheduleInformationId: "schedule-1",
      }),
    );
    expect(core.finishOneShot).toHaveBeenCalledWith({
      scheduleInformationId: "schedule-2",
      status: "fired",
    });
  });

  it("registers the recursive requested kind in an information module", () => {
    expect(() =>
      defineInformationModule({
        manifest: {
          protocolVersion: 1,
          summary: "Test information module.",
          definitionId: "test.scheduler",
          moduleVersion: "1.0.0",
          displayName: "Scheduler test",
          description: "Defines the Scheduler test information module.",
          settingsSchema: z.object({}).strict(),
          consumes: [],
          produces: [oneShotRequestedInformationKind],
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
        },
        create: () => ({ subscriptions: [], provisions: [] }),
      }),
    ).not.toThrow();
  });
});
