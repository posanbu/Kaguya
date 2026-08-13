# @kaguya/config

`@kaguya/config` stores multiple user configuration profiles as JSON. Runtime
modules select a profile explicitly by ID, or omit the ID to use the default.

> Profile JSON contains plaintext API keys and credentials. Treat the complete
> configuration root as sensitive data. Do not commit, log, attach, or publish
> it.

## Example

```ts
import { FileUserConfigManager } from "@kaguya/config";

const readiness = await FileUserConfigManager.inspect({
  rootDir: ".data/kaguya-config",
});

if (readiness.status === "setup_required") {
  // Render readiness.guidance.steps in the UI, collect explicit user input,
  // then call initialize(). Do not generate missing values.
}

const configs = await FileUserConfigManager.open({
  rootDir: ".data/kaguya-config",
});
```

`inspect()` is the first-run, machine-readable check. When the store is
missing, it returns `setup_required` and fixed `guidance.steps` without
creating the root directory, `profiles/`, `index.json`, or a profile. `open()`
only opens an existing store; a missing store throws `CONFIG_SETUP_REQUIRED`
and never creates an empty default profile.

After collecting explicit input, initialize the store with at least two
distinct `providerId:modelId` targets. This example has two targets in one
enabled provider:

```ts
const configs = await FileUserConfigManager.initialize({
  rootDir: ".data/kaguya-config",
  name: "local",
  settings: {
    ai: {
      defaultProviderId: "local-provider",
      modelTiers: {
        light: { providerId: "local-provider", modelId: "model-a" },
        heavy: { providerId: "local-provider", modelId: "model-b" },
      },
      providers: [
        {
          id: "local-provider",
          type: "openai-compatible",
          enabled: true,
          baseUrl: "https://model.example/v1",
          apiKey: "test-only-placeholder",
          models: ["model-a", "model-b"],
          settings: {},
        },
      ],
    },
    platforms: [],
    plugins: [],
  },
  // Add these only after the user explicitly reviews and confirms them.
  acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
});
```

`initialize()` first validates model readiness and optional-configuration
review, then performs its first filesystem mutation. Invalid models produce
`CONFIG_INCOMPLETE`. Unacknowledged optional settings produce
`CONFIG_REVIEW_REQUIRED`; callers must show its secret-free warnings, obtain
explicit confirmation, and retry `initialize()` with the current warning IDs.
For an existing profile, call
`acknowledgeConfigurationWarnings(profileId, warningIds)` only after the same
explicit confirmation. Warning acknowledgements belong to that profile, and a
full `updateProfile()` clears them so the edited configuration must be reviewed
again.

`listProfiles()` returns metadata only. Use `getProfile()` or
`resolveProfileById()` only where runtime code needs the complete
secret-bearing configuration. `resolveProfileById()` validates exactly the
selected profile and never falls back. Existing profiles without
`ai.modelTiers` remain editable, but their readiness is `invalid`; target
selection is never inferred from provider model-array order.

`updateProfile()` replaces the complete `ai`, `platforms`, and `plugins`
settings set; it is not a partial merge. The current default profile may be
edited, but it cannot be renamed or deleted. Legacy session-binding APIs remain
for configuration-store compatibility, but the Runtime and module SDK never
consult them.

At server startup, `KAGUYA_CONFIG_ROOT` is loaded into a frozen profile
registry. The default profile and both tiers must be executable before HTTP or
adapter ingress starts. A module may set `profileId` and `modelTier` to select a
different target. Failure of that selected profile affects only that request;
there is no fallback to the default profile, another provider, or another
model. The legacy `KAGUYA_LLM_API_KEY`, `KAGUYA_LLM_BASE_URL`, and
`KAGUYA_LLM_MODEL` variables are rejected with a value-free migration error.

Existing incomplete profiles can still be opened and edited for repair. The
provider execution layer returns provider/network/authentication failures
directly; it does not attempt a fallback provider or model.

## Storage boundary

- POSIX directories are corrected to `0700`; managed files are corrected to
  `0600`.
- Managed symlinks and paths outside the root are rejected.
- Writes use a synchronized temporary file and atomic replacement.
- Each configuration root must have exactly one live
  `FileUserConfigManager`/writer instance, including within the same process.
  Coordination across manager instances or processes is not supported.
- Windows deployments must apply restrictive NTFS ACLs; POSIX modes do not
  provide an equivalent Windows guarantee.
- Plaintext storage does not protect against the same OS user, administrators,
  host compromise, memory inspection, or unencrypted device theft.

If a real secret enters Git, revoke or rotate it first. Then assess exposure and
remove it from repository history where required.
