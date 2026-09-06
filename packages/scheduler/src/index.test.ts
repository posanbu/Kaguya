/**
 * 功能概述：验证 scheduler 的手动、间隔与 Cron trigger 在泛型 payload 上的调度、取消
 * 和错误隔离语义，不依赖任何业务事件身份。
 * 主要职责：ManualTrigger 用例确认原样传递 payload；Interval/Cron 用例覆盖计时边界、
 * fake timer 触发、取消后不创建 payload，以及 handler/calculator 错误上报。
 * 代码库关系：直接测试 `index.ts` 的通用 Trigger API；Runtime 可用信息输入或普通值组合它，
 * scheduler 本身不导入 schema、engine 或数据库。
 * 输入输出与副作用：使用 Vitest fake timers 或注入 timer doubles，不等待真实长时钟；
 * 每个用例结束后恢复真实计时器。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CronTrigger, IntervalTrigger, ManualTrigger } from "./index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ManualTrigger", () => {
  it("fires immediately without replacing the payload", async () => {
    const trigger = new ManualTrigger<{ readonly tick: number }>();
    const payload = { tick: 1 } as const;
    const handler = vi.fn(
      async (_payload: { readonly tick: number }) => undefined,
    );
    trigger.start(handler);

    const completion = trigger.fire(payload);

    expect(handler).toHaveBeenCalledWith(payload);
    expect(handler.mock.calls[0]?.[0]).toBe(payload);
    await completion;
  });
});

describe("IntervalTrigger", () => {
  it("rejects delays that Node would clamp into a hot loop", () => {
    for (const intervalMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
    ]) {
      expect(
        () =>
          new IntervalTrigger({
            intervalMs,
            createPayload: () => "tick",
          }),
      ).toThrow(/intervalMs/);
    }
  });

  it("emits twice with fake timers and stops after cancellation", async () => {
    vi.useFakeTimers();
    let sequence = 0;
    const trigger = new IntervalTrigger({
      intervalMs: 1_000,
      createPayload: () => ++sequence,
      timers: {
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
      },
    });
    const received: number[] = [];
    const cancel = trigger.start(async (payload) => {
      received.push(payload);
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(received).toEqual([1, 2]);

    cancel();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(received).toEqual([1, 2]);
  });

  it("reports rejected handlers through the configured error callback", async () => {
    vi.useFakeTimers();
    const failure = new Error("interval failed");
    const onError = vi.fn();
    const trigger = new IntervalTrigger({
      intervalMs: 1_000,
      createPayload: () => "tick",
      onError,
    });
    const cancel = trigger.start(async () => {
      throw failure;
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(onError).toHaveBeenCalledWith(failure);
    cancel();
  });

  it("does not create a payload after a queued tick is cancelled", async () => {
    const scheduled: Array<() => void> = [];
    const createPayload = vi.fn(() => "tick");
    const handler = vi.fn(async (_payload: string) => undefined);
    const trigger = new IntervalTrigger({
      intervalMs: 1_000,
      createPayload,
      timers: {
        setInterval: (callback) => {
          scheduled.push(callback);
          return 1 as unknown as ReturnType<typeof globalThis.setInterval>;
        },
        clearInterval: vi.fn(),
      },
    });
    const cancel = trigger.start(handler);

    scheduled[0]?.();
    cancel();
    await Promise.resolve();
    await Promise.resolve();

    expect(createPayload).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("CronTrigger", () => {
  it("exposes its six-field expression and schedules through injected APIs", () => {
    const timeoutHandle = 42 as unknown as ReturnType<
      typeof globalThis.setTimeout
    >;
    const setTimeout = vi.fn(
      (
        _handler: () => void,
        _delayMs: number,
      ): ReturnType<typeof globalThis.setTimeout> => timeoutHandle,
    );
    const clearTimeout = vi.fn(
      (_handle: ReturnType<typeof globalThis.setTimeout>) => undefined,
    );
    const calculateNextRun = vi.fn(() => new Date("2026-07-23T00:00:01.000Z"));
    const trigger = new CronTrigger({
      expression: "0 0 0 * * *",
      calculateNextRun,
      createPayload: () => "tick",
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      timers: { setTimeout, clearTimeout },
    });

    expect(trigger.expression).toBe("0 0 0 * * *");
    const cancel = trigger.start(async () => undefined);
    expect(calculateNextRun).toHaveBeenCalledWith(
      "0 0 0 * * *",
      new Date("2026-07-23T00:00:00.000Z"),
    );
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1_000);

    cancel();
    expect(clearTimeout).toHaveBeenCalledWith(timeoutHandle);
  });

  it("rejects malformed expressions during construction", () => {
    expect(
      () =>
        new CronTrigger({
          expression: "0 0 * * *",
          calculateNextRun: () => new Date(),
          createPayload: () => undefined,
        }),
    ).toThrow(/six-field/);

    for (const expression of [
      "hello world this is not cron",
      "60 0 0 * * *",
      "0 0 0 ?,1 * *",
      "0 0 0 * * ?,1",
      "*/0 0 0 * * *",
      "*/9007199254740992 0 0 * * *",
    ]) {
      expect(
        () =>
          new CronTrigger({
            expression,
            calculateNextRun: () => new Date(),
            createPayload: () => undefined,
          }),
      ).toThrow(/invalid cron/);
    }
  });

  it("does not create a payload after a queued run is cancelled", async () => {
    const scheduled: Array<() => void> = [];
    let nowMs = Date.parse("2026-07-23T00:00:00.000Z");
    const createPayload = vi.fn(() => "tick");
    const handler = vi.fn(async (_payload: string) => undefined);
    const trigger = new CronTrigger({
      expression: "0 0 0 * * *",
      calculateNextRun: (_expression, after) =>
        new Date(after.getTime() + 1_000),
      createPayload,
      now: () => new Date(nowMs),
      timers: {
        setTimeout: (callback) => {
          scheduled.push(callback);
          return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
        },
        clearTimeout: vi.fn(),
      },
    });
    const cancel = trigger.start(handler);

    nowMs += 1_000;
    scheduled[0]?.();
    cancel();
    await Promise.resolve();
    await Promise.resolve();

    expect(createPayload).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports rejected handlers and continues with the next run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
    const failure = new Error("cron failed");
    const onError = vi.fn();
    let calls = 0;
    const trigger = new CronTrigger({
      expression: "0 0 0 * * *",
      calculateNextRun: (_expression, after) =>
        new Date(after.getTime() + 1_000),
      createPayload: () => "tick",
      now: () => new Date(Date.now()),
      onError,
    });
    const cancel = trigger.start(async () => {
      calls += 1;
      if (calls === 1) {
        throw failure;
      }
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledWith(failure);
    cancel();
  });

  it("re-arms long waits without firing before the calculated run", async () => {
    const scheduled: Array<{ handler: () => void; delayMs: number }> = [];
    const setTimeout = vi.fn((handler: () => void, delayMs: number) => {
      scheduled.push({ handler, delayMs });
      return scheduled.length as unknown as ReturnType<
        typeof globalThis.setTimeout
      >;
    });
    let nowMs = Date.parse("2026-07-23T00:00:00.000Z");
    const handler = vi.fn(async () => undefined);
    const trigger = new CronTrigger({
      expression: "0 0 0 1 * *",
      calculateNextRun: (_expression, after) =>
        new Date(after.getTime() + 2_147_483_647 + 5_000),
      createPayload: () => "tick",
      now: () => new Date(nowMs),
      timers: {
        setTimeout,
        clearTimeout: vi.fn(),
      },
    });

    trigger.start(handler);

    expect(scheduled[0]?.delayMs).toBe(2_147_483_647);
    nowMs += 2_147_483_647;
    scheduled[0]?.handler();
    expect(handler).not.toHaveBeenCalled();
    expect(scheduled[1]?.delayMs).toBe(5_000);

    nowMs += 5_000;
    scheduled[1]?.handler();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });
});
