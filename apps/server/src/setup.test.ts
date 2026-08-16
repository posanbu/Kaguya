import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileUserConfigManager } from "@kaguya/config";
import { describe, expect, it } from "vitest";

import { createConfigurationSetup } from "./setup.js";

describe("configuration setup", () => {
  it("initializes a first provider profile through the config manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-"));
    try {
      const setup = createConfigurationSetup(root);
      await expect(setup.inspect()).resolves.toMatchObject({
        status: "setup_required",
      });

      await setup.initialize({
        profileName: "default",
        baseUrl: "https://api.example/v1",
        apiKey: "provider-secret",
        lightModel: "small-model",
        heavyModel: "large-model",
        acknowledgeOptional: true,
      });

      await expect(setup.inspect()).resolves.toEqual({
        status: "restart_required",
      });
      await expect(createConfigurationSetup(root).inspect()).resolves.toEqual({
        status: "ready",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit acknowledgement for omitted optional sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-review-"));
    try {
      const setup = createConfigurationSetup(root);
      await expect(
        setup.initialize({
          profileName: "default",
          baseUrl: "https://api.example/v1",
          apiKey: "provider-secret",
          lightModel: "small-model",
          heavyModel: "large-model",
          acknowledgeOptional: false,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_REVIEW_REQUIRED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects identical light and heavy models", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-models-"));
    try {
      const setup = createConfigurationSetup(root);
      await expect(
        setup.initialize({
          profileName: "default",
          baseUrl: "https://api.example/v1",
          apiKey: "provider-secret",
          lightModel: "same-model",
          heavyModel: "same-model",
          acknowledgeOptional: true,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID_INPUT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["invalid", "review_required"] as const)(
    "repairs an existing %s default profile through the same entry point",
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), `kaguya-setup-${state}-`));
      try {
        const manager = await FileUserConfigManager.initialize({
          rootDir: root,
          name: "existing",
          settings: {
            ai: {
              defaultProviderId: "old-provider",
              modelTiers: {
                light: { providerId: "old-provider", modelId: "old-light" },
                heavy: { providerId: "old-provider", modelId: "old-heavy" },
              },
              providers: [
                {
                  id: "old-provider",
                  type: "openai-compatible",
                  enabled: true,
                  baseUrl: "https://old.example/v1",
                  apiKey: "old-secret",
                  models: ["old-light", "old-heavy"],
                  settings: {},
                },
              ],
            },
            platforms: [],
            plugins: [],
          },
          acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
        });
        const profileId = manager.getDefaultProfileId();
        await manager.updateProfile(
          profileId,
          state === "invalid"
            ? {
                ai: { providers: [] },
                platforms: [],
                plugins: [],
              }
            : {
                ai: {
                  defaultProviderId: "old-provider",
                  modelTiers: {
                    light: {
                      providerId: "old-provider",
                      modelId: "old-light",
                    },
                    heavy: {
                      providerId: "old-provider",
                      modelId: "old-heavy",
                    },
                  },
                  providers: [
                    {
                      id: "old-provider",
                      type: "openai-compatible",
                      enabled: true,
                      baseUrl: "https://old.example/v1",
                      apiKey: "old-secret",
                      models: ["old-light", "old-heavy"],
                      settings: {},
                    },
                  ],
                },
                platforms: [],
                plugins: [],
              },
        );

        const setup = createConfigurationSetup(root);
        await expect(setup.inspect()).resolves.toMatchObject({ status: state });
        await setup.initialize({
          profileName: "ignored-for-existing-profile",
          baseUrl: "https://new.example/v1",
          apiKey: "new-secret",
          lightModel: "new-light",
          heavyModel: "new-heavy",
          acknowledgeOptional: true,
        });

        await expect(setup.inspect()).resolves.toEqual({
          status: "restart_required",
        });
        await expect(createConfigurationSetup(root).inspect()).resolves.toEqual(
          {
            status: "ready",
          },
        );
        await expect(
          (await FileUserConfigManager.open({ rootDir: root })).getProfile(
            profileId,
          ),
        ).resolves.toMatchObject({
          name: "existing",
          ai: {
            defaultProviderId: "default-provider",
            modelTiers: {
              light: { modelId: "new-light" },
              heavy: { modelId: "new-heavy" },
            },
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not overwrite a ready configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-ready-"));
    try {
      const setup = createConfigurationSetup(root);
      await setup.initialize({
        profileName: "default",
        baseUrl: "https://api.example/v1",
        apiKey: "provider-secret",
        lightModel: "small-model",
        heavyModel: "large-model",
        acknowledgeOptional: true,
      });
      const reopenedSetup = createConfigurationSetup(root);

      await expect(
        reopenedSetup.initialize({
          profileName: "replacement",
          baseUrl: "https://replacement.example/v1",
          apiKey: "replacement-secret",
          lightModel: "replacement-light",
          heavyModel: "replacement-heavy",
          acknowledgeOptional: true,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID_INPUT" });

      const manager = await FileUserConfigManager.open({ rootDir: root });
      await expect(
        manager.getProfile(manager.getDefaultProfileId()),
      ).resolves.toMatchObject({
        name: "default",
        ai: { providers: [{ apiKey: "provider-secret" }] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
