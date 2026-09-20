/**
 * 功能概述：钉住表单本地错误与服务端路径定位，避免错误贴到其他 provider 或错误模型层。
 * 主要职责：验证别名关联、超时精度、软预算边界、警告与结构错误分离，以及隐藏 provider 路径。
 * 代码库关系：消费 profile-feedback 与 profile-editor 的纯函数，不依赖 DOM 或真实配置。
 * 输入输出与副作用：只操作虚构 Profile，断言字段及区块，不发请求。
 */
import { describe, expect, it } from "vitest";
import {
  validateProfileFields,
  mapProfileProblem,
} from "./profile-feedback.js";
import { profileToEditorFields } from "./profile-editor.js";
import type { UserConfigProfile } from "./api.js";
const profile: UserConfigProfile = {
  version: 1,
  id: "default",
  name: "default",
  identity: {
    timeZone: "Asia/Shanghai",
  },
  inboundAllowlist: [],
  outboundAllowlist: [],
  ai: {
    defaultProviderId: "editable",
    providers: [
      {
        id: "hidden",
        type: "other",
        enabled: true,
        baseUrl: "https://hidden.example",
        models: [],
        settings: {},
      },
      {
        id: "editable",
        type: "openai-compatible",
        enabled: true,
        baseUrl: "https://example.com/v1",
        apiKey: "fixture",
        models: ["model"],
        settings: {},
      },
    ],
  },
  memory: { enabled: false },
  platforms: [],
};
describe("配置错误定位", () => {
  it("合法表单无错误，数值边界可定位", () => {
    const fields = profileToEditorFields(profile);
    expect(validateProfileFields(fields)).toEqual([]);
    expect(
      validateProfileFields({
        ...fields,
        lightTimeoutSeconds: "300.001",
        heavyRecommendedDurationMs: "3.5",
      }).map((issue) => issue.field),
    ).toEqual(["lightTimeoutSeconds", "heavyRecommendedDurationMs"]);
    expect(
      validateProfileFields({
        ...fields,
        lightTimeoutSeconds: "0.001",
        heavyTimeoutSeconds: "",
      }),
    ).toEqual([]);
  });
  it("不将隐藏 provider 错误贴到当前 API Key", () => {
    expect(
      mapProfileProblem(
        { path: "ai.providers.0.apiKey", message: "missing" },
        profile,
      ),
    ).toMatchObject({ section: "models" });
    expect(
      mapProfileProblem(
        { path: "ai.providers.0.apiKey", message: "missing" },
        profile,
      ).field,
    ).toBeUndefined();
    expect(
      mapProfileProblem(
        { path: "ai.providers.1.apiKey", message: "missing" },
        profile,
      ).field,
    ).toBe("apiKey");
    expect(
      mapProfileProblem(
        {
          path: "ai.modelTiers.heavy.generation.timeoutMs",
          message: "invalid",
        },
        profile,
      ).field,
    ).toBe("heavyTimeoutSeconds");
  });
  it("缺失凭据是警告，不擅自禁止保存", () => {
    expect(
      validateProfileFields({ ...profileToEditorFields(profile), apiKey: "" }),
    ).toEqual([expect.objectContaining({ field: "apiKey", warning: true })]);
  });
  it("拒绝非法 IANA 时区并定位到时区字段", () => {
    expect(
      validateProfileFields({
        ...profileToEditorFields(profile),
        agentTimeZone: "Mars/Olympus",
      }),
    ).toEqual([
      expect.objectContaining({ field: "agentTimeZone", warning: false }),
    ]);
    expect(
      mapProfileProblem(
        { path: "identity.timeZone", message: "invalid" },
        profile,
      ).field,
    ).toBe("agentTimeZone");
  });
});
