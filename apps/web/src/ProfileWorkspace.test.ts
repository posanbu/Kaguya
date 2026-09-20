/**
 * 功能概述：验证顶栏状态不会把编辑、selected 和当前 Runtime 配置混为一谈。
 * 主要职责：覆盖同 ID 不同 revision、切换 selected、应用中与回滚失败的状态组合。
 * 代码库关系：直接调用 ProfileWorkspace 的安全元数据投影；不发网络请求或读取秘密。
 * 输入输出与副作用：使用虚构 revision 断言用户可见标签，防止布局变更改变应用语义。
 */
import { describe, expect, it } from "vitest";
import { profileMenuState } from "./ProfileWorkspace.js";
import type { ConfigurationApplicationStatus } from "./api.js";
const snapshot: ConfigurationApplicationStatus = {
  state: "pending",
  selectedProfileId: "next",
  selectedRevision: "b".repeat(64),
  appliedProfileId: "old",
  appliedRevision: "a".repeat(64),
};
describe("Profile 菜单状态", () => {
  it("绿勾跟随已生效 Profile，不跟随当前选择", () => {
    expect(profileMenuState("draft", snapshot)).toEqual({
      applied: false,
      labels: [],
    });
    expect(profileMenuState("old", snapshot)).toEqual({
      applied: true,
      labels: [],
    });
    expect(profileMenuState("next", snapshot)).toEqual({
      applied: false,
      labels: ["待应用"],
    });
  });
  it("同一 ID 的新 revision 同时表达旧版生效和待应用", () => {
    expect(
      profileMenuState("next", { ...snapshot, appliedProfileId: "next" }),
    ).toEqual({ applied: true, labels: ["待应用"] });
  });
  it("应用期间及失败回滚后均显示明确反馈", () => {
    expect(profileMenuState("next", snapshot, true).labels).toContain("应用中");
    expect(profileMenuState("next", snapshot, false, true).labels).toContain(
      "应用失败",
    );
    expect(
      profileMenuState("next", { ...snapshot, state: "degraded" }).labels,
    ).toContain("应用失败");
  });
});

it("概览首屏尚无 Profile 状态时仍可渲染占位，不伪造 selected", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ProfileWorkspace, ProfileSwitcher } =
    await import("./ProfileWorkspace.js");
  const html = renderToStaticMarkup(
    createElement(ProfileWorkspace, {
      token: "fixture",
      status: undefined,
      reload: async () => undefined,
      children: createElement(ProfileSwitcher),
    }),
  );
  expect(html).toContain("Profile 状态尚未就绪");
  expect(html).not.toContain("default");
});
