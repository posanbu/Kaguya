import { describe, expect, it } from "vitest";

import {
  aiConfigSchema,
  aiProviderConfigSchema,
  platformConfigSchema,
  pluginConfigSchema,
  profileIdSchema,
  userConfigIndexSchema,
  userConfigProfileMetadataSchema,
  userConfigProfileSchema,
  userConfigProfileSettingsSchema,
} from "./model.js";

const profileId = "4f649709-50d9-4fc4-8df4-95f96163f7c9";
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
    "plugin",
    (value: unknown): TestSafeParseResult =>
      pluginConfigSchema.safeParse(value),
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
  it("preserves plaintext AI and platform credentials", () => {
    const profile = userConfigProfileSchema.parse({
      version: 1,
      id: profileId,
      name: "personal",
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
      platforms: [
        {
          id: "platform-1",
          type: "discord",
          enabled: true,
          credentials: { token: "test-platform-token" },
          settings: { guild: "test-guild" },
        },
      ],
      plugins: [
        {
          id: "plugin-1",
          enabled: true,
          settings: { accessToken: "test-plugin-token" },
        },
      ],
    });

    expect(profile.ai.providers[0]?.apiKey).toBe("test-ai-key");
    expect(profile.platforms[0]?.credentials).toEqual({
      token: "test-platform-token",
    });
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
      platforms: [],
      plugins: [],
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

  it("rejects a disabled default provider", () => {
    expect(() =>
      userConfigProfileSettingsSchema.parse({
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
        platforms: [],
        plugins: [],
      }),
    ).toThrow();
  });

  it("rejects an index whose default references a missing profile", () => {
    expect(() =>
      userConfigIndexSchema.parse({
        version: 1,
        defaultProfileId: profileId,
        profiles: [],
        sessionBindings: {},
      }),
    ).toThrow();
  });

  it("rejects an index whose binding references a missing profile", () => {
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
        sessionBindings: {
          "session-1": "a0fc7b07-8a10-4406-970b-88bc74a9416f",
        },
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
        platforms: [],
        plugins: [],
      }).success,
    ).toBe(false);
  });

  it("copies nested JSON objects with null prototypes and preserves prototype-like keys", () => {
    const input = JSON.parse(
      '{"__proto__":{"constructor":{"prototype":"nested"}},"constructor":"own-constructor","prototype":["own-prototype"]}',
    ) as unknown;

    const parsed = userConfigProfileSettingsSchema.parse({
      ai: { providers: [] },
      platforms: [],
      plugins: [{ id: "plugin-1", enabled: true, settings: input }],
    }).plugins[0]!.settings;

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
      ai: { providers: [] },
      platforms: [],
      plugins: [
        {
          id: "plugin-1",
          enabled: true,
          settings: nullPrototypeValue,
        },
      ],
    }).plugins[0]!.settings;

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
      "plugin",
      () =>
        pluginConfigSchema.safeParse({
          id: "plugin-1",
          enabled: true,
          settings: {},
        }).success,
    ],
    [
      "profile settings",
      () =>
        userConfigProfileSettingsSchema.safeParse({
          ai: { providers: [] },
          platforms: [],
          plugins: [],
        }).success,
    ],
    [
      "profile",
      () =>
        userConfigProfileSchema.safeParse({
          version: 1,
          id: profileId,
          name: "default",
          ai: { providers: [] },
          platforms: [],
          plugins: [],
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

  it("rejects an unknown __proto__ session binding in the public index schema", () => {
    const sessionBindings = JSON.parse(
      '{"__proto__":"11111111-1111-4111-8111-111111111111"}',
    ) as unknown;

    expect(
      userConfigIndexSchema.safeParse({
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
        sessionBindings,
      }).success,
    ).toBe(false);
  });

  it("preserves valid prototype-like session bindings in a null-prototype map", () => {
    const sessionBindings = JSON.parse(
      `{"__proto__":"${profileId}","constructor":"${profileId}","prototype":"${profileId}"}`,
    ) as unknown;

    const parsed = userConfigIndexSchema.parse({
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
      sessionBindings,
    });

    expect(Object.getPrototypeOf(parsed.sessionBindings)).toBeNull();
    expect(Object.keys(parsed.sessionBindings)).toEqual([
      "__proto__",
      "constructor",
      "prototype",
    ]);
    expect(parsed.sessionBindings["__proto__"]).toBe(profileId);
    expect(parsed.sessionBindings.constructor).toBe(profileId);
    expect(parsed.sessionBindings.prototype).toBe(profileId);
  });
});
