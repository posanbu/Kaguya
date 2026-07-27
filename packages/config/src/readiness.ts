import { ConfigError } from "./errors.js";
import type { UserConfigProfile } from "./model.js";

export interface ConfigurationGuidanceStep {
  readonly id:
    | "create-profile"
    | "add-enabled-provider"
    | "configure-two-models"
    | "select-default-provider"
    | "review-optional-configuration";
  readonly message: string;
}

export interface ConfigurationGuidance {
  readonly steps: readonly ConfigurationGuidanceStep[];
}

export interface ConfigurationIssue {
  readonly id: string;
  readonly path: string;
  readonly message: string;
}

export interface ConfigurationWarning {
  readonly id: string;
  readonly path: string;
  readonly message: string;
}

export type ProfileReadiness =
  | {
      readonly status: "invalid";
      readonly issues: readonly ConfigurationIssue[];
    }
  | {
      readonly status: "review_required";
      readonly warnings: readonly ConfigurationWarning[];
    }
  | { readonly status: "ready" };

export type ConfigurationReadiness =
  | {
      readonly status: "setup_required";
      readonly guidance: ConfigurationGuidance;
    }
  | ProfileReadiness;

export const configurationSetupGuidance: ConfigurationGuidance = Object.freeze({
  steps: Object.freeze([
    Object.freeze({
      id: "create-profile" as const,
      message: "Create your first profile.",
    }),
    Object.freeze({
      id: "add-enabled-provider" as const,
      message: "Add and enable an AI provider.",
    }),
    Object.freeze({
      id: "configure-two-models" as const,
      message: "Configure at least two models.",
    }),
    Object.freeze({
      id: "select-default-provider" as const,
      message: "Select a default provider.",
    }),
    Object.freeze({
      id: "review-optional-configuration" as const,
      message: "Review and acknowledge optional configuration.",
    }),
  ]),
});

export function inspectUserConfigProfile(
  profile: UserConfigProfile,
): ProfileReadiness {
  const issues = deriveConfigurationIssues(profile);
  if (issues.length > 0) {
    return { status: "invalid", issues };
  }

  const acknowledgedWarnings = new Set(
    profile.review?.acknowledgedWarnings ?? [],
  );
  const warnings = deriveConfigurationWarnings(profile).filter(
    (warning) => !acknowledgedWarnings.has(warning.id),
  );
  if (warnings.length > 0) {
    return { status: "review_required", warnings };
  }

  return { status: "ready" };
}

export function deriveConfigurationWarnings(
  profile: UserConfigProfile,
): readonly ConfigurationWarning[] {
  const warnings: ConfigurationWarning[] = [];

  for (const [providerIndex, provider] of profile.ai.providers.entries()) {
    if (!provider.enabled) {
      continue;
    }
    if (provider.baseUrl === undefined) {
      warnings.push({
        id: `provider-base-url-missing:${provider.id}`,
        path: `ai.providers.${providerIndex}.baseUrl`,
        message: "An enabled provider is missing its base URL.",
      });
    }
    if (provider.apiKey === undefined) {
      warnings.push({
        id: `provider-api-key-missing:${provider.id}`,
        path: `ai.providers.${providerIndex}.apiKey`,
        message: "An enabled provider is missing its API key.",
      });
    }
  }

  if (profile.platforms.length === 0) {
    warnings.push({
      id: "platforms-empty",
      path: "platforms",
      message: "No platforms are configured.",
    });
  }
  if (profile.plugins.length === 0) {
    warnings.push({
      id: "plugins-empty",
      path: "plugins",
      message: "No plugins are configured.",
    });
  }

  return warnings;
}

function deriveConfigurationIssues(
  profile: UserConfigProfile,
): readonly ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const defaultProviderId = profile.ai.defaultProviderId;
  if (defaultProviderId === undefined) {
    issues.push({
      id: "default-provider-missing",
      path: "ai.defaultProviderId",
      message: "A default provider must be selected.",
    });
  } else if (
    !profile.ai.providers.some(
      (provider) => provider.id === defaultProviderId && provider.enabled,
    )
  ) {
    issues.push({
      id: "default-provider-not-enabled",
      path: "ai.defaultProviderId",
      message: "The default provider must be enabled.",
    });
  }

  const targets = new Set<string>();
  for (const [providerIndex, provider] of profile.ai.providers.entries()) {
    if (!provider.enabled) {
      continue;
    }
    if (provider.models.length === 0) {
      issues.push({
        id: `enabled-provider-models-empty:${provider.id}`,
        path: `ai.providers.${providerIndex}.models`,
        message: "An enabled provider must include a model.",
      });
    }

    const seenModels = new Set<string>();
    for (const [modelIndex, modelId] of provider.models.entries()) {
      if (seenModels.has(modelId)) {
        issues.push({
          id: `duplicate-model:${provider.id}:${modelId}`,
          path: `ai.providers.${providerIndex}.models.${modelIndex}`,
          message: "Model IDs must be unique within an enabled provider.",
        });
      }
      seenModels.add(modelId);
      targets.add(`${provider.id}:${modelId}`);
    }
  }

  if (targets.size < 2) {
    issues.push({
      id: "insufficient-model-targets",
      path: "ai.providers",
      message: "At least two distinct model targets must be configured.",
    });
  }

  return issues;
}

export class ConfigSetupRequiredError extends ConfigError {
  readonly guidance: ConfigurationGuidance;

  constructor(guidance: ConfigurationGuidance) {
    super("CONFIG_SETUP_REQUIRED", "Configuration setup is required.");
    this.name = "ConfigSetupRequiredError";
    this.guidance = {
      steps: guidance.steps.map((step) => ({ ...step })),
    };
  }
}

export class ConfigIncompleteError extends ConfigError {
  readonly issues: readonly ConfigurationIssue[];

  constructor(issues: readonly ConfigurationIssue[]) {
    super("CONFIG_INCOMPLETE", "Configuration is incomplete.");
    this.name = "ConfigIncompleteError";
    this.issues = issues.map((issue) => ({ ...issue }));
  }
}

export class ConfigReviewRequiredError extends ConfigError {
  readonly warnings: readonly ConfigurationWarning[];

  constructor(warnings: readonly ConfigurationWarning[]) {
    super("CONFIG_REVIEW_REQUIRED", "Configuration review is required.");
    this.name = "ConfigReviewRequiredError";
    this.warnings = warnings.map((warning) => ({ ...warning }));
  }
}
