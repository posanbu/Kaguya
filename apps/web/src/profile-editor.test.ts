/**
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
  plugins: [
    {
      id: "plugin-1",
      enabled: true,
      settings: {
        nested: { keep: true },
      },
    },
    {
      id: "plugin-2",
      enabled: false,
      settings: {
        threshold: 7,
      },
    },
  ],
  review: {
    acknowledgedWarnings: [
      "platforms-empty",
      "plugins-empty",
      "provider-base-url-missing:default-provider",
    ],
  },
};

const emptyDefaultProfile: UserConfigProfile = {
  version: 1,
  id: "default",
  name: "default",
  ai: {
    providers: [],
  },
  platforms: [],
  plugins: [],
};

const warningProfile: UserConfigProfile = {
  version: 1,
  id: "warning-profile",
  name: "Warning",
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
  platforms: [],
  plugins: [],
  review: {
    acknowledgedWarnings: [
      "provider-base-url-missing:default-provider",
      "platforms-empty",
      "plugins-empty",
    ],
  },
};

describe("profileToEditorFields", () => {
  it("extracts the visible fields from a populated profile", () => {
    expect(profileToEditorFields(completeProfile)).toEqual({
      name: "Production",
      baseUrl: "https://api.example/v1",
      apiKey: "provider-secret",
      lightModel: "light-model",
      heavyModel: "heavy-model",
      acknowledgeOptional: true,
    });
  });

  it("returns empty editor fields for the reserved default profile", () => {
    expect(profileToEditorFields(emptyDefaultProfile)).toEqual({
      name: "default",
      baseUrl: "",
      apiKey: "",
      lightModel: "",
      heavyModel: "",
      acknowledgeOptional: false,
    });
  });
});

describe("mergeProfileEditorFields", () => {
  it("updates only the visible provider fields and preserves hidden data", () => {
    const fields = profileToEditorFields(completeProfile);
    const merged = mergeProfileEditorFields(completeProfile, {
      ...fields,
      name: "Production v2",
      baseUrl: "https://api.example/v2",
      apiKey: "provider-secret-v2",
      lightModel: "light-model-v2",
      heavyModel: "heavy-model-v2",
      acknowledgeOptional: false,
    });

    expect(merged).toEqual({
      name: "Production v2",
      acknowledgedWarnings: [],
      ai: {
        defaultProviderId: "default-provider",
        modelTiers: {
          light: {
            providerId: "default-provider",
            modelId: "light-model-v2",
          },
          heavy: {
            providerId: "default-provider",
            modelId: "heavy-model-v2",
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
      plugins: [
        {
          id: "plugin-1",
          enabled: true,
          settings: {
            nested: { keep: true },
          },
        },
        {
          id: "plugin-2",
          enabled: false,
          settings: {
            threshold: 7,
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
      acknowledgeOptional: true,
    });

    expect(merged).toEqual({
      name: "default",
      acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
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
            settings: {},
          },
        ],
      },
      platforms: [],
      plugins: [],
    });
  });

  it("keeps still-valid hidden warnings when the base URL changes", () => {
    const merged = mergeProfileEditorFields(warningProfile, {
      ...profileToEditorFields(warningProfile),
      baseUrl: "https://api.example/v2",
      acknowledgeOptional: true,
    });

    expect(merged.acknowledgedWarnings).toEqual([
      "platforms-empty",
      "plugins-empty",
    ]);
  });

  it("removes only the optional warning ids when the checkbox is cleared", () => {
    const merged = mergeProfileEditorFields(warningProfile, {
      ...profileToEditorFields(warningProfile),
      acknowledgeOptional: false,
    });

    expect(merged.acknowledgedWarnings).toEqual([
      "provider-base-url-missing:default-provider",
    ]);
  });
});
