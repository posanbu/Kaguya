/**
 * 测试配置分别声明 inboundAllowlist/outboundAllowlist，保持与严格 Profile 或 Runtime 出站策略契约一致。
 * 超时回归覆盖秒/毫秒往返、空值默认和非法值拒绝，并验证保存不丢失其他 Provider 数据。
 * 架构说明：本测试文件定义 Web 端 Profile 编辑器的纯函数边界，
 * 用来保证展示层字段与完整 Profile 之间的映射不会丢失任何未展示的
 * 平台、插件、提供方设置或敏感值。它是 `profile-editor.ts` 的守门测试，
 * 也是 Task 7 之前的客户端数据保全基线：当前页面只会改动明面上
 * 可编辑的名称、URL、模型和确认状态，其余结构必须原样保留。
 * 主要职责：验证 `profileToEditorFields` 能从完整 Profile 提取可编辑字段；
 * 验证 `mergeProfileEditorFields` 会在复用现有 OpenAI-compatible provider
 * 的前提下，精确更新可见字段，同时保留隐藏 provider/platform/plugin 数据；
 * 还要覆盖空 `default` Profile 的补全路径，确保只在需要时补出
 * `default-provider` 和两个 tier 目标，不伪造平台或插件。
 * 代码库关系：该文件只依赖 `apps/web/src/profile-editor.ts` 与
 * `@kaguya/config` 的公开类型，不触碰服务器端逻辑；Task 7 会把这些
 * helper 接到页面表单，而这里负责证明 helper 本身不会误删或重排隐藏设置。
 * 输入输出与副作用：所有断言都在内存中进行；若 helper 共享原对象引用、
 * 覆盖隐藏字段或忘记补齐空默认 Profile，这里会直接失败。
 */
import { describe, expect, it } from "vitest";

import {
  mergeProfileEditorFields,
  profileToEditorFields,
} from "./profile-editor.js";
import type { UserConfigProfile } from "./api.js";

const completeProfile: UserConfigProfile = {
  version: 1,
  id: "b3f1d59f-f1e2-4b63-b9de-d1aa8d0d1c44",
  name: "Production",
  inboundAllowlist: ["qq:group:778899", "invalid-rule"],
  outboundAllowlist: ["qq:group:778899", "invalid-rule"],
  identity: {
    timeZone: "Asia/Shanghai",
  },
  ai: {
    defaultProviderId: "default-provider",
    modelTiers: {
      light: { providerId: "default-provider", modelId: "light-model" },
      heavy: { providerId: "default-provider", modelId: "heavy-model" },
    },
    providers: [
      {
        id: "default-provider",
        type: "openai-compatible",
        enabled: true,
        baseUrl: "https://api.example/v1",
        apiKey: "provider-secret",
        models: ["light-model", "heavy-model"],
        settings: {
          nested: { keep: true },
          array: [1, 2, 3],
        },
      },
      {
        id: "secondary-provider",
        type: "anthropic-compatible",
        enabled: false,
        models: ["claude-opus"],
        settings: {
          nested: { keep: "secondary" },
        },
      },
    ],
  },
  memory: { enabled: true },
  platforms: [
    {
      id: "qq",
      type: "qq",
      enabled: true,
      credentials: {
        token: "platform-secret",
        meta: { keep: true },
      },
      settings: {
        nested: { keep: true },
      },
    },
  ],
  review: {
    acknowledgedWarnings: ["provider-base-url-missing:default-provider"],
  },
};

const emptyDefaultProfile: UserConfigProfile = {
  version: 1,
  id: "default",
  name: "default",
  inboundAllowlist: [],
  outboundAllowlist: [],
  identity: {
    timeZone: "Asia/Shanghai",
  },
  ai: {
    providers: [],
  },
  memory: { enabled: false },
  platforms: [],
};

const warningProfile: UserConfigProfile = {
  version: 1,
  id: "warning-profile",
  name: "Warning",
  inboundAllowlist: ["*:private:*"],
  outboundAllowlist: ["*:private:*"],
  identity: {
    timeZone: "Asia/Shanghai",
  },
  ai: {
    defaultProviderId: "default-provider",
    modelTiers: {
      light: { providerId: "default-provider", modelId: "light-model" },
      heavy: { providerId: "default-provider", modelId: "heavy-model" },
    },
    providers: [
      {
        id: "default-provider",
        type: "openai-compatible",
        enabled: true,
        apiKey: "provider-secret",
        models: ["light-model", "heavy-model"],
        settings: {},
      },
    ],
  },
  memory: { enabled: false },
  platforms: [],
  review: {
    acknowledgedWarnings: ["provider-base-url-missing:default-provider"],
  },
};

describe("profileToEditorFields", () => {
  it("extracts the visible fields from a populated profile", () => {
    expect(profileToEditorFields(completeProfile)).toEqual({
      name: "Production",
      agentTimeZone: "Asia/Shanghai",
      baseUrl: "https://api.example/v1",
      apiKey: "provider-secret",
      lightModel: "light-model",
      heavyModel: "heavy-model",
      lightTimeoutSeconds: "300",
      heavyTimeoutSeconds: "300",
      lightThinkingEnabled: true,
      lightReasoningEffort: "provider-default",
      lightRecommendedDurationMs: "2000",
      heavyThinkingEnabled: true,
      heavyReasoningEffort: "provider-default",
      heavyRecommendedDurationMs: "5000",
      inboundAllowlistText: "qq:group:778899\ninvalid-rule",
      outboundAllowlistText: "qq:group:778899\ninvalid-rule",
      memoryEnabled: true,
    });
  });

  it("returns empty editor fields for the reserved default profile", () => {
    expect(profileToEditorFields(emptyDefaultProfile)).toEqual({
      name: "default",
      agentTimeZone: "Asia/Shanghai",
      baseUrl: "",
      apiKey: "",
      lightModel: "",
      heavyModel: "",
      lightTimeoutSeconds: "300",
      heavyTimeoutSeconds: "300",
      lightThinkingEnabled: true,
      lightReasoningEffort: "provider-default",
      lightRecommendedDurationMs: "2000",
      heavyThinkingEnabled: true,
      heavyReasoningEffort: "provider-default",
      heavyRecommendedDurationMs: "5000",
      inboundAllowlistText: "",
      outboundAllowlistText: "",
      memoryEnabled: false,
    });
  });

  it("round-trips AI SDK reasoning effort and the thinking-mode switch", () => {
    const profile: UserConfigProfile = {
      ...completeProfile,
      ai: {
        ...completeProfile.ai,
        modelTiers: {
          light: {
            providerId: "default-provider",
            modelId: "light-model",
            generation: { reasoning: "none" },
          },
          heavy: {
            providerId: "default-provider",
            modelId: "heavy-model",
            generation: { reasoning: "high" },
          },
        },
      },
    };
    const fields = profileToEditorFields(profile);
    expect(fields).toMatchObject({
      lightThinkingEnabled: false,
      lightReasoningEffort: "provider-default",
      heavyThinkingEnabled: true,
      heavyReasoningEffort: "high",
    });
    const tiers = profile.ai.modelTiers;
    if (tiers === undefined) throw new Error("Expected model tiers");
    expect(
      mergeProfileEditorFields(profile, fields).ai.modelTiers,
    ).toMatchObject(tiers);
  });
});

describe("mergeProfileEditorFields", () => {
  it("updates only the visible provider fields and preserves hidden data", () => {
    const fields = profileToEditorFields(completeProfile);
    const merged = mergeProfileEditorFields(completeProfile, {
      ...fields,
      name: "Production v2",
      agentTimeZone: " Asia/Tokyo ",
      baseUrl: "https://api.example/v2",
      apiKey: "provider-secret-v2",
      lightModel: "light-model-v2",
      heavyModel: "heavy-model-v2",
      inboundAllowlistText:
        " qq:group:778899 \n\ninvalid-rule\nqq:group:778899",
      memoryEnabled: false,
    });

    expect(merged).toEqual({
      name: "Production v2",
      inboundAllowlist: ["qq:group:778899", "invalid-rule", "qq:group:778899"],
      outboundAllowlist: ["qq:group:778899", "invalid-rule"],
      identity: {
        timeZone: "Asia/Tokyo",
      },
      acknowledgedWarnings: [],
      ai: {
        defaultProviderId: "default-provider",
        modelTiers: {
          light: {
            providerId: "default-provider",
            modelId: "light-model-v2",
            generation: { timeoutMs: 300_000 },
            recommendedDurationMs: 2000,
          },
          heavy: {
            providerId: "default-provider",
            modelId: "heavy-model-v2",
            generation: { timeoutMs: 300_000 },
            recommendedDurationMs: 5000,
          },
        },
        providers: [
          {
            id: "default-provider",
            type: "openai-compatible",
            enabled: true,
            baseUrl: "https://api.example/v2",
            apiKey: "provider-secret-v2",
            models: ["light-model-v2", "heavy-model-v2"],
            settings: {
              nested: { keep: true },
              array: [1, 2, 3],
            },
          },
          {
            id: "secondary-provider",
            type: "anthropic-compatible",
            enabled: false,
            models: ["claude-opus"],
            settings: {
              nested: { keep: "secondary" },
            },
          },
        ],
      },
      memory: { enabled: false },
      platforms: [
        {
          id: "qq",
          type: "qq",
          enabled: true,
          credentials: {
            token: "platform-secret",
            meta: { keep: true },
          },
          settings: {
            nested: { keep: true },
          },
        },
      ],
    });
  });

  it("fills an empty default profile without fabricating hidden collections", () => {
    const fields = profileToEditorFields(emptyDefaultProfile);
    const merged = mergeProfileEditorFields(emptyDefaultProfile, {
      ...fields,
      baseUrl: "https://api.example/v1",
      apiKey: "provider-secret",
      lightModel: "light-model",
      heavyModel: "heavy-model",
    });

    expect(merged).toEqual({
      name: "default",
      inboundAllowlist: [],
      outboundAllowlist: [],
      identity: {
        timeZone: "Asia/Shanghai",
      },
      acknowledgedWarnings: [],
      ai: {
        defaultProviderId: "default-provider",
        modelTiers: {
          light: {
            providerId: "default-provider",
            modelId: "light-model",
            generation: { timeoutMs: 300_000 },
            recommendedDurationMs: 2000,
          },
          heavy: {
            providerId: "default-provider",
            modelId: "heavy-model",
            generation: { timeoutMs: 300_000 },
            recommendedDurationMs: 5000,
          },
        },
        providers: [
          {
            id: "default-provider",
            type: "openai-compatible",
            enabled: true,
            baseUrl: "https://api.example/v1",
            apiKey: "provider-secret",
            models: ["light-model", "heavy-model"],
            settings: {},
          },
        ],
      },
      memory: { enabled: false },
      platforms: [],
    });
  });

  it("keeps still-valid hidden warnings when the base URL changes", () => {
    const merged = mergeProfileEditorFields(warningProfile, {
      ...profileToEditorFields(warningProfile),
      baseUrl: "https://api.example/v2",
    });

    expect(merged.acknowledgedWarnings).toEqual([]);
  });

  it("keeps unresolved provider warnings without optional configuration warnings", () => {
    const merged = mergeProfileEditorFields(warningProfile, {
      ...profileToEditorFields(warningProfile),
    });

    expect(merged.acknowledgedWarnings).toEqual([
      "provider-base-url-missing:default-provider",
    ]);
  });
});

it("round trips independent tier timeouts in seconds without changing the input", () => {
  const before = structuredClone(completeProfile);
  const fields = profileToEditorFields(completeProfile);
  const saved = mergeProfileEditorFields(completeProfile, {
    ...fields,
    lightTimeoutSeconds: "1.001",
    heavyTimeoutSeconds: "300",
  });
  expect(saved.ai.modelTiers?.light.generation?.timeoutMs).toBe(1_001);
  expect(saved.ai.modelTiers?.heavy.generation?.timeoutMs).toBe(300_000);
  expect(
    profileToEditorFields({ ...completeProfile, ai: saved.ai })
      .lightTimeoutSeconds,
  ).toBe("1.001");
  expect(completeProfile).toEqual(before);
  expect(
    mergeProfileEditorFields(completeProfile, {
      ...fields,
      lightTimeoutSeconds: "",
    }).ai.modelTiers?.light.generation?.timeoutMs,
  ).toBeUndefined();
});
it.each(["0", "-1", "301", "NaN", "0.0001", "Infinity"])(
  "rejects invalid timeout %s before saving",
  (value) => {
    expect(() =>
      mergeProfileEditorFields(completeProfile, {
        ...profileToEditorFields(completeProfile),
        lightTimeoutSeconds: value,
      }),
    ).toThrow("模型超时");
  },
);

it("edits outbound rules without changing inbound rules and preserves separate empty lists", () => {
  const fields = profileToEditorFields(completeProfile);
  const merged = mergeProfileEditorFields(completeProfile, {
    ...fields,
    outboundAllowlistText: " *:private:* \n qq:group:REPLACE_GROUP_ID ",
  });
  expect(merged.inboundAllowlist).toEqual(completeProfile.inboundAllowlist);
  expect(merged.outboundAllowlist).toEqual([
    "*:private:*",
    "qq:group:REPLACE_GROUP_ID",
  ]);
  expect(
    mergeProfileEditorFields(completeProfile, {
      ...fields,
      inboundAllowlistText: "",
      outboundAllowlistText: "",
    }),
  ).toMatchObject({ inboundAllowlist: [], outboundAllowlist: [] });
});
