import { describe, expect, it } from "vitest";

import {
  userConfigIndexSchema,
  userConfigProfileSchema,
  userConfigProfileSettingsSchema,
} from "./model.js";

const profileId = "4f649709-50d9-4fc4-8df4-95f96163f7c9";

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

    expect(() =>
      userConfigProfileSettingsSchema.parse({
        ai: {
          defaultProviderId: "provider-1",
          providers: [
            duplicateProvider,
            { ...duplicateProvider, enabled: false },
          ],
        },
        platforms: [],
        plugins: [],
      }),
    ).toThrow();
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
});
