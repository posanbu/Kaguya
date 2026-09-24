/**
 * 功能概述：验证 Planner 查询预算不会被早期长消息独占，证据合并保持多来源公平。
 * 主要职责：覆盖 Unicode 上限、最近话题、长消息首尾、重复输入与原文 ID 去重。
 * 代码库关系：直接测试 Knowledge 与 sparse 共用的纯查询策略，无数据库或模型请求。
 */
import { expect, it } from "vitest";
import { buildRecallQuery, mergeRecallLanes } from "./recall-query.js";
import { atom } from "../message-composer/test-fixtures.js";

it("keeps later topics and both ends of a long message within the query budget", () => {
  const query = buildRecallQuery([
    "旧话题".repeat(600),
    "开头" + "🌟".repeat(600) + "结尾",
    "木星观测",
  ]);
  expect(query.startsWith("木星观测\n")).toBe(true);
  expect(query).toContain("开头");
  expect(query).toContain("结尾");
  expect(Array.from(query).length).toBeLessThanOrEqual(512);
});

it("deduplicates inputs and bounds the recent input window", () => {
  expect(buildRecallQuery([" ", "同一话题", "同一话题"])).toBe("同一话题");
  expect(buildRecallQuery([])).toBe("");
  const query = buildRecallQuery(
    Array.from({ length: 1000 }, (_, index) => `话题-${index}`),
  );
  expect(query.split("\n")).toHaveLength(8);
  expect(query).toContain("话题-999");
  expect(query).not.toContain("话题-991");
});

it("interleaves distinct evidence and never exceeds the shared cap", () => {
  const a = atom("a", "core.memory.text", { text: "a" });
  const b = atom("b", "core.memory.text", { text: "b" });
  const c = atom("c", "core.memory.text", { text: "c" });
  expect(
    mergeRecallLanes(
      [
        [a, b],
        [a, c],
      ],
      3,
    ),
  ).toEqual([a, b, c]);
  expect(mergeRecallLanes([[a, b], [c]], 2)).toEqual([a, c]);
  expect(mergeRecallLanes([[a]], 0)).toEqual([]);
});
