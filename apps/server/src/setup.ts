import {
  ConfigError,
  FileUserConfigManager,
  type ConfigurationReadiness,
} from "@kaguya/config";

export interface InitialConfigurationInput {
  readonly profileName: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly lightModel: string;
  readonly heavyModel: string;
  readonly acknowledgeOptional: boolean;
}

export type ConfigurationSetupStatus =
  ConfigurationReadiness | { readonly status: "restart_required" };

export interface ConfigurationSetup {
  inspect(): Promise<ConfigurationSetupStatus>;
  initialize(input: InitialConfigurationInput): Promise<void>;
}

const initialProviderId = "default-provider";

export function createConfigurationSetup(rootDir: string): ConfigurationSetup {
  let restartRequired = false;
  return {
    inspect: () =>
      restartRequired
        ? Promise.resolve({ status: "restart_required" as const })
        : FileUserConfigManager.inspect({ rootDir }),
    initialize: async (input) => {
      if (input.lightModel.trim() === input.heavyModel.trim()) {
        throw new ConfigError(
          "CONFIG_INVALID_INPUT",
          "Light and heavy models must be different",
        );
      }
      if (!input.acknowledgeOptional) {
        throw new ConfigError(
          "CONFIG_REVIEW_REQUIRED",
          "Optional configuration must be reviewed",
        );
      }

      const settings = initialProfileSettings(input);
      const readiness = await FileUserConfigManager.inspect({ rootDir });
      if (readiness.status === "setup_required") {
        await FileUserConfigManager.initialize({
          rootDir,
          name: input.profileName,
          settings,
          acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
        });
      } else {
        if (readiness.status === "ready") {
          throw new ConfigError(
            "CONFIG_INVALID_INPUT",
            "Configuration setup is not required",
          );
        }
        const manager = await FileUserConfigManager.open({ rootDir });
        const profileId = manager.getDefaultProfileId();
        await manager.updateProfile(profileId, settings);
        await manager.acknowledgeConfigurationWarnings(profileId, [
          "platforms-empty",
          "plugins-empty",
        ]);
      }
      restartRequired = true;
    },
  };
}

function initialProfileSettings(input: InitialConfigurationInput) {
  return {
    ai: {
      defaultProviderId: initialProviderId,
      modelTiers: {
        light: {
          providerId: initialProviderId,
          modelId: input.lightModel,
        },
        heavy: {
          providerId: initialProviderId,
          modelId: input.heavyModel,
        },
      },
      providers: [
        {
          id: initialProviderId,
          type: "openai-compatible",
          enabled: true,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          models: [input.lightModel, input.heavyModel],
          settings: {},
        },
      ],
    },
    platforms: [],
    plugins: [],
  };
}

export function isConfigurationInputError(error: unknown): boolean {
  return (
    error instanceof ConfigError &&
    (error.code === "CONFIG_INVALID_INPUT" ||
      error.code === "CONFIG_INCOMPLETE" ||
      error.code === "CONFIG_REVIEW_REQUIRED")
  );
}
