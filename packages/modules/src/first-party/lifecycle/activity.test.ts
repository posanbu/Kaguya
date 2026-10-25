import { expect, it } from "vitest";
import { advanceActivity } from "./activity.js";
const at = (ms: number) => new Date(Date.UTC(2026, 9, 22) + ms).toISOString();
const tick = { scopeIdleMs: 120000, reason: "pulse" };
it("coalesces ticks, preserves changes and freezes older snapshots", () => {
  const first = advanceActivity(undefined, { ...tick, at: at(0) });
  const frozen = structuredClone(first);
  const next = advanceActivity(first, { ...tick, at: at(5000) });
  expect(first).toEqual(frozen);
  expect(next.timeline).toHaveLength(1);
  expect(next.timeline[0]).toMatchObject({
    startedAt: at(0),
    through: at(5000),
  });
  const scope = advanceActivity(next, {
    ...tick,
    at: at(6000),
    scopeKey: "qq:a:group:1",
    actual: true,
  });
  const other = advanceActivity(scope, {
    ...tick,
    at: at(7000),
    scopeKey: "qq:a:group:2",
    actual: true,
  });
  expect(other.timeline.map((s) => s.scopeKey)).toEqual([
    null,
    "qq:a:group:1",
    "qq:a:group:2",
  ]);
  expect(other.scopeActivityAt).toEqual({
    "qq:a:group:1": at(6000),
    "qq:a:group:2": at(7000),
  });
});
it("leaves exactly at two minutes, while a task holds its current activity", () => {
  const first = advanceActivity(undefined, {
    ...tick,
    at: at(0),
    actual: true,
    scopeKey: "group",
  });
  expect(
    advanceActivity(first, { ...tick, at: at(119999) }).timeline.at(-1)
      ?.activity,
  ).toBe("observing");
  expect(
    advanceActivity(first, { ...tick, at: at(120000) }).timeline.at(-1)
      ?.activity,
  ).toBe("idle");
  expect(
    advanceActivity(first, { ...tick, at: at(120000), busy: true }).timeline.at(
      -1,
    )?.activity,
  ).toBe("working");
});
it("keeps an ongoing span older than ten minutes and does not refresh actual activity", () => {
  const first = advanceActivity(undefined, { ...tick, at: at(0) });
  const next = advanceActivity(first, { ...tick, at: at(3600000) });
  expect(next.timeline[0]?.startedAt).toBe(at(0));
  expect(next.lastActivityAt).toBe(at(0));
});
it("does not carry a morning topic into the evening's current activity", () => {
  const morning = advanceActivity(undefined, {
    ...tick,
    at: at(0),
    scopeKey: "qq:a:group:low-temperature",
    actual: true,
  });
  const evening = advanceActivity(morning, { ...tick, at: at(43200000) });
  expect(evening.timeline.at(-1)).toMatchObject({
    activity: "idle",
    scopeKey: null,
  });
  expect(morning.timeline.at(-1)?.activity).toBe("observing");
});
