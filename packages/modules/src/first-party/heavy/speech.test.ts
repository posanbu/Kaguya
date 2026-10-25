import { describe, expect, it, vi } from "vitest";
import { informationIdSchema } from "@kaguya/schema";
import {
  DurableOneShotScheduler,
  FakeScheduleClock,
  type OneShotScheduleProjectionStore,
} from "@kaguya/scheduler";
import { pacingSchema, speechReadyAt } from "./speech.js";
import { heavySettingsSchema, messageResponseOutputSchema } from "./index.js";

const start = "2026-10-21T00:00:00.000Z";
const duration = (text: string, id = "step-1") =>
  Date.parse(speechReadyAt(start, id, text)) - Date.parse(start);
describe("speech pacing and compatibility", () => {
  it.each([100, 1500])(
    "schedules only the remaining typing time after %i ms of generation",
    async (generationMs) => {
      const clock = new FakeScheduleClock(start);
      const scheduleId = informationIdSchema.parse("speech-schedule");
      const dueId = informationIdSchema.parse("speech-due");
      const dueAt = speechReadyAt(start, "clock-step", "这是一条短消息");
      await clock.advanceTo(new Date(Date.parse(start) + generationMs));
      const emitDue = vi.fn(async () => ({
        scheduleInformationId: scheduleId,
        dueInformationId: dueId,
        created: true,
      }));
      const unused = async (): Promise<never> => {
        throw new Error("Unexpected schedule write");
      };
      const store: OneShotScheduleProjectionStore = {
        create: unused,
        replace: unused,
        finish: unused,
        emitDue,
        listOpen: async ({ after }) => ({
          arms: after ? [] : [{ scheduleInformationId: scheduleId, dueAt }],
        }),
      };
      const scheduler = new DurableOneShotScheduler({
        store,
        clock,
        nextInformationId: () => dueId,
      });
      try {
        await scheduler.start();
        if (generationMs < Date.parse(dueAt) - Date.parse(start)) {
          expect(emitDue).not.toHaveBeenCalled();
          await clock.advanceTo(new Date(Date.parse(dueAt) - 1));
          expect(emitDue).not.toHaveBeenCalled();
          await clock.advanceTo(new Date(dueAt));
        }
        expect(emitDue).toHaveBeenCalledTimes(1);
        expect(clock.pendingTimerCount()).toBe(0);
      } finally {
        await scheduler.stop();
      }
    },
  );
  it("keeps old settings and single-message outputs valid", () => {
    expect(heavySettingsSchema.parse({})).toEqual({});
    expect(
      messageResponseOutputSchema.parse({
        action: "message",
        text: "一句说完",
      }),
    ).toEqual({ action: "message", text: "一句说完" });
    expect(
      messageResponseOutputSchema.safeParse({
        action: "message",
        text: "先说一句",
        continuation: "",
      }).success,
    ).toBe(false);
  });
  it("uses bounded, stable jitter and counts Unicode code points", () => {
    for (const id of ["one", "two", "three"]) {
      expect(duration("", id)).toBe(200);
      expect(duration("字".repeat(1000), id)).toBe(1200);
      expect(duration("字".repeat(20), id)).toBeGreaterThanOrEqual(
        650 * 0.85 - 1,
      );
      expect(duration("字".repeat(20), id)).toBeLessThanOrEqual(650 * 1.15 + 1);
      expect(duration("😀".repeat(20), id)).toBe(duration("字".repeat(20), id));
      expect(duration("字".repeat(20), id)).toBe(duration("字".repeat(20), id));
    }
  });
  it("counts model time toward the deadline and permits configuration", () => {
    const due = Date.parse(speechReadyAt(start, "slow", "字".repeat(1000)));
    expect(Math.max(0, due - (Date.parse(start) + 1500))).toBe(0);
    expect(
      speechReadyAt(
        start,
        "off",
        "hello",
        pacingSchema.parse({ minMs: 0, maxMs: 0 }),
      ),
    ).toBe(start);
    expect(pacingSchema.safeParse({ minMs: 1000, maxMs: 100 }).success).toBe(
      false,
    );
  });
});
