/**
 * 架构说明：本测试守护配置模型的注册表契约，覆盖 Profile ID、v1 索引
 * 以及唯一性和引用完整性约束，确保管理器与 API 只能依赖这里定义的持久化
 * 结构，而不会回退到旧版 defaultProfileId 语义。
 */
import { describe, expect, it } from "vitest";

const identity = { name: "Kaguya", aliases: ["辉夜"], persona: "test" };

import {
  aiConfigSchema,
  aiProviderConfigSchema,
  modelTiersSchema,
  platformConfigSchema,
  profileIdSchema,
  runtimeConfigSchema,
  userConfigIndexSchema,
  userConfigProfileMetadataSchema,
  userConfigProfileSchema,
  userConfigProfileSettingsSchema,
} from "./model.js";

const profileId = "4f649709-50d9-4fc4-8df4-95f96163f7c9";
const defaultMetadata = {
  id: "default",
  name: "default",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};
const userProfileId = profileId;
type TestSafeParseResult = { success: boolean; error?: unknown };

const publicSchemaParsers = [
  [
    "profile ID",
    (value: unknown): TestSafeParseResult => profileIdSchema.safeParse(value),
  ],
  [
    "AI provider",
    (value: unknown): TestSafeParseResult =>
      aiProviderConfigSchema.safeParse(value),
  ],
  [
    "AI configuration",
    (value: unknown): TestSafeParseResult => aiConfigSchema.safeParse(value),
  ],
  [
    "platform",
    (value: unknown): TestSafeParseResult =>
      platformConfigSchema.safeParse(value),
  ],
  [
    "profile settings",
    (value: unknown): TestSafeParseResult =>
      userConfigProfileSettingsSchema.safeParse(value),
  ],
  [
    "profile",
    (value: unknown): TestSafeParseResult =>
      userConfigProfileSchema.safeParse(value),
  ],
  [
    "profile metadata",
    (value: unknown): TestSafeParseResult =>
      userConfigProfileMetadataSchema.safeParse(value),
  ],
  [
    "configuration index",
    (value: unknown): TestSafeParseResult =>
      userConfigIndexSchema.safeParse(value),
  ],
] as const;

function createRevokedProxy(): object {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

function createThrowingGetterProxy(secret: string): object {
  return new Proxy(
    {},
    {
      get(): never {
        throw new Error(secret);
      },
    },
  );
}

describe("user configuration schemas", () => {
  it("accepts strict per-tier generation controls and soft duration budgets", () => {
    const tiers = modelTiersSchema.parse({
      light: {
        providerId: "provider",
        modelId: "fast-model",
        generation: {
          reasoning: "minimal",
        },
        recommendedDurationMs: 2_000,
      },
      heavy: {
        providerId: "provider",
        modelId: "deep-model",
        generation: { reasoning: "high" },
        recommendedDurationMs: 8_000,
      },
    });
    expect(tiers.light.generation?.reasoning).toBe("minimal");
    expect(
      modelTiersSchema.safeParse({
        ...tiers,
        light: { ...tiers.light, unknown: true },
      }).success,
    ).toBe(false);
    expect(
      modelTiersSchema.safeParse({
        ...tiers,
        light: { ...tiers.light, generation: { maxOutputTokens: 256 } },
      }).success,
    ).toBe(false);
    expect(
      modelTiersSchema.safeParse({
        ...tiers,
        heavy: { ...tiers.heavy, generation: { tokenBudget: 1000 } },
      }).success,
    ).toBe(false);
    expect(
      modelTiersSchema.safeParse({
        ...tiers,
        heavy: { ...tiers.heavy, generation: { thinkingBudget: "high" } },
      }).success,
    ).toBe(false);
  });

  it("requires an explicit Agent identity on existing Profiles", () => {
    expect(
      userConfigProfileSchema.safeParse({
        version: 1,
        id: profileId,
        name: "legacy",
        ai: { providers: [] },
        memory: { enabled: false },
        platforms: [],
      }).success,
    ).toBe(false);
  });

  it("normalizes identity text and rejects duplicate or primary-name aliases", () => {
    expect(
      userConfigProfileSettingsSchema.parse({
        identity: {
          name: " Kaguya ",
          aliases: [" 辉夜 ", "Moon"],
          persona: " concise ",
        },
        ai: { providers: [] },
        memory: { enabled: false },
        platforms: [],
      }).identity,
    ).toEqual({
      name: "Kaguya",
      aliases: ["辉夜", "Moon"],
      persona: "concise",
    });
    expect(
      userConfigProfileSettingsSchema.parse({
        identity: {
          name: "Kaguya",
          aliases: ["辉夜", " 辉夜 "],
          persona: "test",
        },
        ai: { providers: [] },
        memory: { enabled: false },
        platforms: [],
      }).identity.aliases,
    ).toEqual(["辉夜"]);
    expect(
      userConfigProfileSettingsSchema.safeParse({
        identity: { name: "Kaguya", aliases: ["Kaguya"], persona: "test" },
        ai: { providers: [] },
        memory: { enabled: false },
        platforms: [],
      }).success,
    ).toBe(false);
  });
  it("requires databaseMode and rejects a persisted gateway token", () => {
    const runtimeInput = {
      host: "127.0.0.1",
      port: 3000,
      databaseMode: "external" as const,
      databaseUrl: "postgresql://profile:secret@database.example/kaguya",
      webDistPath: "apps/web/dist",
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 30,
      rateLimitWindowMs: 60_000,
      logLevel: "info",
      logFormat: "json",
      gatewayAllowlist: ["qq:group:778899", "*:private:*", "invalid"],
    };
    const runtime = runtimeConfigSchema.parse(runtimeInput);

    expect(runtime.databaseMode).toBe("external");
    expect(runtime.gatewayAllowlist).toEqual([
      "qq:group:778899",
      "*:private:*",
      "invalid",
    ]);
    const { databaseMode: _databaseMode, ...withoutDatabaseMode } =
      runtimeInput;
    expect(runtimeConfigSchema.safeParse(withoutDatabaseMode).success).toBe(
      false,
    );
    expect(
      runtimeConfigSchema.safeParse({
        ...runtimeInput,
        gatewayToken: "legacy-gateway-token",
      }).success,
    ).toBe(false);
  });

  it("rejects legacy gateway allowlist objects and non-string rules", () => {
    const baseRuntime = {
      host: "127.0.0.1",
      port: 3000,
      databaseUrl: "postgresql://profile:secret@database.example/kaguya",
      webDistPath: "apps/web/dist",
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 30,
      rateLimitWindowMs: 60_000,
      logLevel: "info",
      logFormat: "json",
    };

    expect(
      runtimeConfigSchema.safeParse({
        ...baseRuntime,
        gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSchema.safeParse({
        ...baseRuntime,
        gatewayAllowlist: ["qq:group:778899", 42],
      }).success,
    ).toBe(false);
  });

  it("accepts the reserved default profile ID and rejects non-UUID names", () => {
    expect(profileIdSchema.parse("default")).toBe("default");
    expect(profileIdSchema.safeParse("named-profile").success).toBe(false);
  });

  it("accepts a v1 registry index with a selected default profile", () => {
    expect(
      userConfigIndexSchema.parse({
        version: 1,
        selectedProfileId: "default",
        profiles: [defaultMetadata],
      }),
    ).toMatchObject({ version: 1, selectedProfileId: "default" });
  });

  it("rejects a v1 registry index whose selected profile is missing", () => {
    expect(
      userConfigIndexSchema.safeParse({
        version: 1,
        selectedProfileId: userProfileId,
        profiles: [defaultMetadata],
      }).success,
    ).toBe(false);
  });

  it("rejects a registry index without the default profile", () => {
    expect(
      userConfigIndexSchema.safeParse({
        version: 1,
        selectedProfileId: "default",
        profiles: [
          {
            ...defaultMetadata,
            id: profileId,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a registry index when the default profile name is not default", () => {
    expect(
      userConfigIndexSchema.safeParse({
        version: 1,
        selectedProfileId: "default",
        profiles: [
          {
            ...defaultMetadata,
            name: "personal",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate profile IDs", () => {
    expect(
      userConfigIndexSchema.safeParse({
        version: 1,
        selectedProfileId: "default",
        profiles: [
          defaultMetadata,
          {
            ...defaultMetadata,
            createdAt: "2026-08-30T01:00:00.000Z",
            updatedAt: "2026-08-30T01:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate profile names", () => {
    expect(
      userConfigIndexSchema.safeParse({
        version: 1,
        selectedProfileId: "default",
        profiles: [
          defaultMetadata,
          {
            id: profileId,
            name: "default",
            createdAt: "2026-08-30T01:00:00.000Z",
            updatedAt: "2026-08-30T01:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a legacy index that still uses defaultProfileId", () => {
    expect(
      userConfigIndexSchema.safeParse({
        version: 1,
        defaultProfileId: "default",
        profiles: [defaultMetadata],
      }).success,
    ).toBe(false);
  });

  it.each([2, 3])("rejects registry index version %s", (version) => {
    expect(
      userConfigIndexSchema.safeParse({
        version,
        selectedProfileId: "default",
        profiles: [defaultMetadata],
      }).success,
    ).toBe(false);
  });

  it("preserves plaintext AI and platform credentials", () => {
    const profile = userConfigProfileSchema.parse({
      version: 1,
      id: profileId,
      name: "personal",
      identity,
      ai: {
        defaultProviderId: "provider-1",
        providers: [
          {
            id: "provider-1",
            type: "openai-compatible",
            enabled: true,
            baseUrl: "https://model.example/v1",
            apiKey: "test-ai-key",
            models: ["model-a"],
            settings: { organization: "test-org" },
          },
        ],
      },
      memory: { enabled: false },
      platforms: [
        {
          id: "platform-1",
          type: "discord",
          enabled: true,
          credentials: { token: "test-platform-token" },
          settings: { guild: "test-guild" },
        },
      ],
    });

    expect(profile.ai.providers[0]?.apiKey).toBe("test-ai-key");
    expect(profile.platforms[0]?.credentials).toEqual({
      token: "test-platform-token",
    });
  });

  it("requires Memory settings and preserves explicit enablement", () => {
    const base = {
      identity,
      ai: { providers: [] },
      platforms: [],
    };

    expect(userConfigProfileSettingsSchema.safeParse(base).success).toBe(false);
    expect(
      userConfigProfileSettingsSchema.parse({
        ...base,
        memory: { enabled: true },
      }).memory,
    ).toEqual({ enabled: true });
    expect(
      userConfigProfileSettingsSchema.safeParse({
        ...base,
        memory: { enabled: false, provider: "unexpected" },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate provider IDs", () => {
    const duplicateProvider = {
      id: "provider-1",
      type: "openai-compatible",
      enabled: true,
      models: [],
      settings: {},
    };

    const result = userConfigProfileSettingsSchema.safeParse({
      ai: {
        defaultProviderId: "provider-1",
        providers: [
          duplicateProvider,
          { ...duplicateProvider, enabled: false },
        ],
      },
      memory: { enabled: false },
      platforms: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: "custom",
          path: ["ai", "providers", 1, "id"],
        }),
      );
    }
  });

  it("allows a disabled default provider so the draft can be repaired", () => {
    expect(
      userConfigProfileSettingsSchema.parse({
        identity,
        ai: {
          defaultProviderId: "provider-1",
          providers: [
            {
              id: "provider-1",
              type: "openai-compatible",
              enabled: false,
              models: [],
              settings: {},
            },
          ],
        },
        memory: { enabled: false },
        platforms: [],
      }).ai.defaultProviderId,
    ).toBe("provider-1");
  });

  it("rejects retired persisted warning acknowledgements", () => {
    expect(
      userConfigProfileSchema.safeParse({
        version: 1,
        id: profileId,
        name: "personal",
        ai: { providers: [] },
        memory: { enabled: false },
        platforms: [],
        review: { acknowledgedWarnings: ["platforms-empty"] },
      }).success,
    ).toBe(false);
  });

  it("rejects an index whose default references a missing profile", () => {
    expect(() =>
      userConfigIndexSchema.parse({
        version: 2,
        defaultProfileId: profileId,
        profiles: [],
      }),
    ).toThrow();
  });

  it("rejects a legacy index containing session bindings", () => {
    expect(() =>
      userConfigIndexSchema.parse({
        version: 1,
        defaultProfileId: profileId,
        profiles: [
          {
            id: profileId,
            name: "default",
            createdAt: "2026-07-25T00:00:00.000Z",
            updatedAt: "2026-07-25T00:00:00.000Z",
          },
        ],
        sessionBindings: {},
      }),
    ).toThrow();
  });

  it.each([
    ["undefined", undefined],
    ["function", () => "not-json"],
    ["symbol", Symbol("not-json")],
    ["bigint", 1n],
    ["Date", new Date("2026-07-25T00:00:00.000Z")],
    ["Map", new Map([["key", "value"]])],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["custom class", new (class CustomValue {})()],
    ["toJSON", { toJSON: () => ({ accepted: true }) }],
  ])("rejects nested non-JSON %s values", (_label, invalidValue) => {
    expect(
      userConfigProfileSettingsSchema.safeParse({
        ai: {
          providers: [
            {
              id: "provider-1",
              type: "test",
              enabled: true,
              models: [],
              settings: { nested: [null, { invalidValue }] },
            },
          ],
        },
        memory: { enabled: false },
        platforms: [],
      }).success,
    ).toBe(false);
  });

  it("copies nested JSON objects with null prototypes and preserves prototype-like keys", () => {
    const input = JSON.parse(
      '{"__proto__":{"constructor":{"prototype":"nested"}},"constructor":"own-constructor","prototype":["own-prototype"]}',
    ) as unknown;

    const parsed = userConfigProfileSettingsSchema.parse({
      identity,
      ai: {
        providers: [
          {
            id: "provider-1",
            type: "test",
            enabled: true,
            models: [],
            settings: input,
          },
        ],
      },
      memory: { enabled: false },
      platforms: [],
    }).ai.providers[0]!.settings;

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.hasOwn(parsed, "constructor")).toBe(true);
    expect(Object.hasOwn(parsed, "prototype")).toBe(true);
    expect(Object.getPrototypeOf(parsed["__proto__"])).toBeNull();
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
  });

  it("accepts the complete recursive JSON value domain", () => {
    const nullPrototypeValue = Object.create(null) as Record<string, unknown>;
    nullPrototypeValue.nested = {
      nullValue: null,
      stringValue: "text",
      booleanValue: true,
      numberValue: -1.25,
      arrayValue: [null, "text", false, 0],
    };

    const parsed = userConfigProfileSettingsSchema.parse({
      identity,
      ai: {
        providers: [
          {
            id: "provider-1",
            type: "test",
            enabled: true,
            models: [],
            settings: nullPrototypeValue,
          },
        ],
      },
      memory: { enabled: false },
      platforms: [],
    }).ai.providers[0]!.settings;

    expect(JSON.stringify(parsed)).toBe(JSON.stringify(nullPrototypeValue));
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(parsed.nested)).toBeNull();
  });

  it.each(publicSchemaParsers)(
    "%s safeParse returns a failure for a revoked proxy",
    (_name, safeParse) => {
      let result: TestSafeParseResult | undefined;

      expect(() => {
        result = safeParse(createRevokedProxy());
      }).not.toThrow();
      expect(result).toMatchObject({ success: false });
    },
  );

  it.each(publicSchemaParsers)(
    "%s safeParse drops throwing getter errors",
    (_name, safeParse) => {
      const secret = "schema-getter-secret";
      let result: TestSafeParseResult | undefined;

      expect(() => {
        result = safeParse(createThrowingGetterProxy(secret));
      }).not.toThrow();
      expect(result).toMatchObject({ success: false });
      expect(String(result?.error)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it.each([
    ["profile ID", () => profileIdSchema.safeParse(profileId).success],
    [
      "AI provider",
      () =>
        aiProviderConfigSchema.safeParse({
          id: "provider-1",
          type: "test",
          enabled: true,
          models: [],
          settings: {},
        }).success,
    ],
    [
      "AI configuration",
      () => aiConfigSchema.safeParse({ providers: [] }).success,
    ],
    [
      "platform",
      () =>
        platformConfigSchema.safeParse({
          id: "platform-1",
          type: "test",
          enabled: true,
          credentials: {},
          settings: {},
        }).success,
    ],
    [
      "profile settings",
      () =>
        userConfigProfileSettingsSchema.safeParse({
          identity,
          ai: { providers: [] },
          memory: { enabled: false },
          platforms: [],
        }).success,
    ],
    [
      "profile",
      () =>
        userConfigProfileSchema.safeParse({
          version: 1,
          id: profileId,
          name: "default",
          identity,
          ai: { providers: [] },
          memory: { enabled: false },
          platforms: [],
        }).success,
    ],
    [
      "profile metadata",
      () =>
        userConfigProfileMetadataSchema.safeParse({
          id: profileId,
          name: "default",
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
        }).success,
    ],
    [
      "configuration index",
      () =>
        userConfigIndexSchema.safeParse({
          version: 1,
          selectedProfileId: "default",
          profiles: [
            {
              id: "default",
              name: "default",
              createdAt: "2026-07-25T00:00:00.000Z",
              updatedAt: "2026-07-25T00:00:00.000Z",
            },
          ],
        }).success,
    ],
  ])("continues to accept valid %s input", (_name, parse) => {
    expect(parse()).toBe(true);
  });

  it.each([
    [
      "baseUrl",
      () =>
        aiProviderConfigSchema.safeParse({
          id: "provider-1",
          type: "test",
          enabled: true,
          baseUrl: undefined,
          models: [],
          settings: {},
        }).success,
    ],
    [
      "apiKey",
      () =>
        aiProviderConfigSchema.safeParse({
          id: "provider-1",
          type: "test",
          enabled: true,
          apiKey: undefined,
          models: [],
          settings: {},
        }).success,
    ],
    [
      "defaultProviderId",
      () =>
        aiConfigSchema.safeParse({
          defaultProviderId: undefined,
          providers: [],
        }).success,
    ],
    [
      "review",
      () =>
        userConfigProfileSchema.safeParse({
          version: 1,
          id: profileId,
          name: "default",
          ai: { providers: [] },
          memory: { enabled: false },
          platforms: [],
          review: undefined,
        }).success,
    ],
  ])("rejects an own optional %s key with undefined", (_field, parse) => {
    expect(parse()).toBe(false);
  });

  it("allows optional provider keys to be absent without adding them", () => {
    const provider = aiProviderConfigSchema.parse({
      id: "provider-1",
      type: "test",
      enabled: true,
      models: [],
      settings: {},
    });
    const ai = aiConfigSchema.parse({ providers: [provider] });

    expect(Object.hasOwn(provider, "baseUrl")).toBe(false);
    expect(Object.hasOwn(provider, "apiKey")).toBe(false);
    expect(Object.hasOwn(ai, "defaultProviderId")).toBe(false);
  });

  it("rejects removed binding fields in the public index schema", () => {
    expect(
      userConfigIndexSchema.safeParse({
        version: 2,
        defaultProfileId: profileId,
        profiles: [
          {
            id: profileId,
            name: "default",
            createdAt: "2026-07-25T00:00:00.000Z",
            updatedAt: "2026-07-25T00:00:00.000Z",
          },
        ],
        sessionBindings: {},
      }).success,
    ).toBe(false);
  });
});
