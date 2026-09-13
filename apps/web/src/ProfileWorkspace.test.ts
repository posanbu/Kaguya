/**
 * 功能概述：验证顶栏状态不会把编辑、selected 和当前 Runtime 配置混为一谈。
 * 主要职责：覆盖同 ID 不同 revision、切换 selected、应用中与回滚失败的状态组合。
 * 代码库关系：直接调用 ProfileWorkspace 的安全元数据投影；不发网络请求或读取秘密。
 * 输入输出与副作用：使用虚构 revision 断言用户可见标签，防止布局变更改变应用语义。
 */
import { describe, expect, it } from "vitest";
import { profileLabels } from "./ProfileWorkspace.js";
import type { ConfigurationApplicationStatus } from "./api.js";
const snapshot: ConfigurationApplicationStatus = {
  state: "pending",
  selectedProfileId: "next",
  selectedRevision: "b".repeat(64),
  appliedProfileId: "old",
  appliedRevision: "a".repeat(64),
};
describe("Profile 状态标签", () => {
  it("编辑其他 Profile 不会将其标记为 selected 或已生效", () => {
    expect(profileLabels("draft", "next", snapshot)).toEqual([]);
    expect(profileLabels("old", "next", snapshot)).toEqual(["已生效"]);
    expect(profileLabels("next", "next", snapshot)).toEqual([
      "selected（当前选择）",
      "待应用",
    ]);
  });
  it("同一 ID 的新 revision 同时表达旧版生效和待应用", () => {
    expect(
      profileLabels("next", "next", { ...snapshot, appliedProfileId: "next" }),
    ).toEqual(["selected（当前选择）", "已生效", "待应用"]);
  });
  it("应用期间及失败回滚后均显示明确反馈", () => {
    expect(profileLabels("next", "next", snapshot, true)).toContain("应用中");
    expect(profileLabels("next", "next", snapshot, false, true)).toContain(
      "应用失败",
    );
    expect(
      profileLabels("next", "next", { ...snapshot, state: "degraded" }),
    ).toContain("应用失败");
  });
});
