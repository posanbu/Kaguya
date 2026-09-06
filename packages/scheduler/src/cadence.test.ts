import { describe, expect, it } from "vitest";
import { computeCadenceWindow } from "./cadence.js";

describe("computeCadenceWindow", () => {
  it("uses fixed anchor boundaries and coalesces missed windows", () => {
    const anchor = new Date("2026-09-01T00:00:00.000Z");
    const window = computeCadenceWindow(
      anchor,
      6 * 60 * 60 * 1000,
      new Date("2026-09-02T00:00:00.000Z"),
      1,
    );
    expect(window).toMatchObject({
      windowIndex: 4,
      missedCount: 3,
      scheduledAt: new Date("2026-09-02T00:00:00.000Z"),
      earliestMissedBoundary: new Date("2026-09-01T12:00:00.000Z"),
    });
  });

  it("does not create a future window or drift from completion time", () => {
    const anchor = new Date("2026-09-01T00:00:00.000Z");
    expect(
      computeCadenceWindow(
        anchor,
        60_000,
        new Date("2026-08-31T23:59:59.000Z"),
        -1,
      ),
    ).toBeUndefined();
    expect(
      computeCadenceWindow(
        anchor,
        60_000,
        new Date("2026-09-01T00:02:00.000Z"),
        2,
      ),
    ).toBeUndefined();
  });
});
