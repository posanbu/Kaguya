/**
 * 功能概述：校验错误投影的保密和定位回归测试。
 * 主要职责：覆盖 AJV required、Zod 路径、未知秘密键和消息不回显、条数上限。
 * 代码库关系：测试 profile-field-errors 的允许路径策略，补充 app.inject 的真实路由测试。
 * 输入输出与副作用：纯内存虚构错误，不记录或发送真实配置。
 */
import { expect, it } from "vitest";
import { profileFieldErrors } from "./profile-field-errors.js";
it("只返回允许路径，不回显错误 message、输入值或任意键", () => {
  const result = profileFieldErrors({
    issues: [
      { path: ["identity", "aliases", 0], message: "SECRET" },
      { path: ["ai", "providers", 0, "settings", "SECRET"], input: "SECRET" },
    ],
  });
  expect(result.map((issue) => issue.path)).toEqual(["identity.aliases.0", ""]);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});
it("AJV required 指向所属字段，未知错误安全返回空列表", () => {
  expect(
    profileFieldErrors({
      validation: [
        { instancePath: "/identity", params: { missingProperty: "persona" } },
      ],
    })[0]?.path,
  ).toBe("identity.persona");
  expect(
    profileFieldErrors({
      validation: [
        { instancePath: "/identity", params: { missingProperty: "timeZone" } },
      ],
    })[0]?.path,
  ).toBe("identity.timeZone");
  expect(profileFieldErrors(new Error("SECRET"))).toEqual([]);
});
