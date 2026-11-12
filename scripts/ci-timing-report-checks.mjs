import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, markdown, collect } from "./ci-timing-report.mjs";
const run = {
  id: 1,
  workflow_id: 42,
  status: "completed",
  html_url: "https://example.test/1",
  event: "pull_request",
  run_attempt: 1,
  conclusion: "success",
  created_at: "2026-10-23T00:00:00Z",
};
const job = (name, start, end) => ({
  name,
  started_at: `2026-10-23T00:${start}:00Z`,
  completed_at: `2026-10-23T00:${end}:00Z`,
  conclusion: "success",
});
test("separates wall time, startup wait and parallel runner time", () => {
  const result = summarize(run, [job("a", "01", "03"), job("b", "01", "04")]);
  assert.equal(result.elapsedSeconds, 240);
  assert.equal(result.initialWaitSeconds, 60);
  assert.equal(result.executionSpanSeconds, 180);
  assert.equal(result.runnerMinutes, 5);
  assert.match(markdown([result]), /超过 180 秒 1 次/);
});
test("missing times stay unknown and skipped jobs do not consume runner time", () => {
  const result = summarize(run, [{ name: "skipped", conclusion: "skipped" }]);
  assert.equal(result.elapsedSeconds, null);
  assert.equal(result.runnerMinutes, 0);
  assert.equal(result.jobs[0].seconds, null);
});
test("cancelled and rerun samples cannot make the first-attempt budget look green", () => {
  const result = summarize(
    { ...run, run_attempt: 2, conclusion: "cancelled" },
    [job("a", "01", "05")],
  );
  assert.match(markdown([result]), /非取消样本 0 次/);
});
test("collects each event separately, deduplicates and paginates jobs for the exact attempt", async () => {
  const calls = [];
  const request = async (route) => {
    calls.push(route);
    if (route.endsWith("/workflows/test.yml")) return { id: 42 };
    if (route.endsWith("/runs/1")) return run;
    if (route.includes("/jobs?"))
      return {
        jobs: route.endsWith("page=1")
          ? Array.from({ length: 100 }, () => job("x", "01", "02"))
          : [job("last", "02", "03")],
      };
    return { workflow_runs: [run] };
  };
  const reports = await collect(request, "owner/repo", 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].jobs.length, 101);
  assert.ok(calls.some((route) => route.includes("event=schedule")));
  assert.ok(
    calls.some((route) =>
      route.includes("/attempts/1/jobs?per_page=100&page=2"),
    ),
  );
});

test("incomplete job timestamps cannot understate totals or imply the target was met", () => {
  for (const broken of [
    { name: "missing", conclusion: "failure" },
    { ...job("invalid", "01", "03"), completed_at: "invalid" },
    job("reversed", "04", "02"),
  ]) {
    const result = summarize(run, [job("known", "01", "02"), broken]);
    assert.equal(result.elapsedSeconds, null);
    assert.equal(result.runnerMinutes, null);
    assert.match(markdown([result]), /耗时未知 1 次/);
    assert.match(markdown([result]), /部分作业耗时未知/);
  }
  assert.equal(summarize(run, []).runnerMinutes, null);
});

test("compares timestamp instants rather than timezone strings", () => {
  const result = summarize(run, [
    {
      ...job("a", "01", "02"),
      started_at: "2026-10-23T08:01:00+08:00",
      completed_at: "2026-10-23T08:02:00+08:00",
    },
    job("b", "01", "04"),
  ]);
  assert.equal(result.elapsedSeconds, 240);
  assert.equal(result.executionSpanSeconds, 180);
});

test("rejects unrelated or unfinished trigger runs before collecting history", async () => {
  for (const invalid of [
    { ...run, workflow_id: 99 },
    { ...run, status: "in_progress" },
  ]) {
    const calls = [];
    await assert.rejects(
      collect(
        async (route) => {
          calls.push(route);
          return route.endsWith("/workflows/test.yml") ? { id: 42 } : invalid;
        },
        "owner/repo",
        1,
      ),
      /completed Test workflow/,
    );
    assert.equal(calls.length, 2);
  }
});
