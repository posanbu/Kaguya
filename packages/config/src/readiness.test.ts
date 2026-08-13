import { describe, expect, it } from "vitest";

import {
  inspectUserConfigProfile,
  type UserConfigProfile,
  userConfigProfileSchema,
} from "./index.js";

function profileWith(
  providers: UserConfigProfile["ai"]["providers"],
  overrides: Partial<UserConfigProfile> = {},
): UserConfigProfile {
  const targets = providers.flatMap((provider) =>
    provider.models.map((modelId) => ({ providerId: provider.id, modelId })),
  );
  const light = targets[0] ?? { providerId: "missing", modelId: "missing" };
  const heavy = targets[1] ?? light;
  return userConfigProfileSchema.parse({
    version: 1,
    id: "4f649709-50d9-4fc4-8df4-95f96163f7c9",
    name: "test",
    ai: {
      defaultProviderId: providers[0]?.id,
      modelTiers: { light, heavy },
      providers,
    },
    platforms: [
      {
        id: "platform-1",
        type: "test",
        enabled: true,
        credentials: {},
        settings: {},
      },
    ],
    plugins: [{ id: "plugin-1", enabled: true, settings: {} }],
    ...overrides,
  });
}

describe("inspectUserConfigProfile", () => {
  it("rejects tiers that point to the same model target", () => {
    const readiness = inspectUserConfigProfile(
      profileWith([
        {
          id: "provider-1",
          type: "test",
          enabled: true,
          baseUrl: "https://models.example/v1",
          apiKey: "placeholder-api-key",
          models: ["model-1"],
          settings: {},
        },
      ]),
    );

    expect(readiness).toMatchObject({
      status: "invalid",
      issues: [
        {
          id: "model-tier-targets-not-distinct",
          path: "ai.modelTiers",
        },
      ],
    });
  });

  it("accepts two distinct models in one enabled provider", () => {
    expect(
      inspectUserConfigProfile(
        profileWith([
          {
            id: "provider-1",
            type: "test",
            enabled: true,
            baseUrl: "https://models.example/v1",
            apiKey: "placeholder-api-key",
            models: ["model-1", "model-2"],
            settings: {},
          },
        ]),
      ),
    ).toEqual({ status: "ready" });
  });

  it("accepts one enabled model in each of two providers", () => {
    expect(
      inspectUserConfigProfile(
        profileWith([
          {
            id: "provider-1",
            type: "test",
            enabled: true,
            baseUrl: "https://models.example/v1",
            apiKey: "placeholder-api-key",
            models: ["model-1"],
            settings: {},
          },
          {
            id: "provider-2",
            type: "test",
            enabled: true,
            baseUrl: "https://models.example/v1",
            apiKey: "placeholder-api-key",
            models: ["model-1"],
            settings: {},
          },
        ]),
      ),
    ).toEqual({ status: "ready" });
  });

  it("reports unacknowledged optional configuration without warning for disabled providers", () => {
    const readiness = inspectUserConfigProfile(
      profileWith(
        [
          {
            id: "provider-1",
            type: "test",
            enabled: true,
            models: ["model-1", "model-2"],
            settings: {},
          },
          {
            id: "provider-disabled",
            type: "test",
            enabled: false,
            models: [],
            settings: {},
          },
        ],
        { platforms: [], plugins: [] },
      ),
    );

    expect(readiness).toMatchObject({
      status: "review_required",
      warnings: [
        {
          id: "provider-base-url-missing:provider-1",
          path: "ai.providers.0.baseUrl",
        },
        {
          id: "provider-api-key-missing:provider-1",
          path: "ai.providers.0.apiKey",
        },
        { id: "platforms-empty", path: "platforms" },
        { id: "plugins-empty", path: "plugins" },
      ],
    });
    if (readiness.status === "review_required") {
      expect(readiness.warnings).toHaveLength(4);
    }
  });

  it("does not serialize secrets from API keys or JSON settings", () => {
    const secret = "placeholder-readiness-secret";
    const readiness = inspectUserConfigProfile(
      profileWith([
        {
          id: "provider-1",
          type: "test",
          enabled: true,
          baseUrl: "https://models.example/v1",
          apiKey: secret,
          models: ["model-1", "model-2"],
          settings: { secret },
        },
      ]),
    );

    expect(JSON.stringify(readiness)).not.toContain(secret);
  });
});
