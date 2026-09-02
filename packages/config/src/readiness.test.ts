/**
 * 架构说明：本测试守护配置就绪态对外输出的安全契约，确保存在仓库
 * 只暴露元数据、selectedProfileId、问题与警告，不泄漏 Profile 正文、
 * API Key、provider settings 或其它敏感载荷。
 */
import { describe, expect, it } from "vitest";

import {
  withRegistryReadiness,
  inspectUserConfigProfile,
  type UserConfigProfile,
  type UserConfigProfileMetadata,
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
      ...(providers[0] === undefined
        ? {}
        : { defaultProviderId: providers[0].id }),
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

const defaultMetadata: UserConfigProfileMetadata = {
  id: "default",
  name: "default",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

describe("inspectUserConfigProfile", () => {
  it("surfaces existing-store readiness with metadata and selected profile id", () => {
    const readiness = withRegistryReadiness(
      [defaultMetadata],
      "default",
      inspectUserConfigProfile(profileWith([])),
    );

    expect(readiness).toMatchObject({
      status: "invalid",
      selectedProfileId: "default",
      profiles: [defaultMetadata],
      issues: expect.arrayContaining([
        expect.objectContaining({ id: "default-provider-missing" }),
      ]),
    });
  });

  it("does not serialize selected profile metadata secrets", () => {
    const secret = "placeholder-readiness-secret";
    const profiles = [structuredClone(defaultMetadata)];
    const readiness = withRegistryReadiness(
      profiles,
      "default",
      inspectUserConfigProfile(
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
      ),
    );

    expect(JSON.stringify(readiness)).not.toContain(secret);
  });

  it("detaches the registry metadata snapshot from caller mutation", () => {
    const profiles = [structuredClone(defaultMetadata)];
    const readiness = withRegistryReadiness(
      profiles,
      "default",
      inspectUserConfigProfile(profileWith([])),
    );

    profiles[0]!.name = "mutated";

    expect(readiness.profiles[0]).toEqual(defaultMetadata);
  });

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
