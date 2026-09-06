# @kaguya/config

`@kaguya/config` stores multiple user configuration profiles as JSON under a v3
registry with one explicit global selection. Runtime modules do not choose a
profile; the server resolves the selected profile once at startup and every
module shares that frozen runtime configuration.

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
  // then call bootstrap(). Do not generate missing values.
}

await FileUserConfigManager.bootstrap({
  rootDir: ".data/kaguya-config",
});

const configs = await FileUserConfigManager.open({
  rootDir: ".data/kaguya-config",
});
```

`inspect()` is the first-run, machine-readable check. When the store is
missing, it returns `setup_required` and fixed `guidance.steps` without
creating the root directory, `profiles/`, `index.json`, or a profile.
`bootstrap()` is the only operation that creates the empty v3 registry:
`index.json` with `selectedProfileId: "default"` plus one empty reserved
`default` profile. `open()` only opens an existing store; a missing store
throws `CONFIG_SETUP_REQUIRED` and never creates files implicitly.

After bootstrap, replace the selected profile with explicit user-provided
settings. This example updates the reserved `default` profile with two
distinct `providerId:modelId` targets in one enabled provider:

```ts
const configs = await FileUserConfigManager.open({
  rootDir: ".data/kaguya-config",
});

await configs.replaceProfile("default", {
  name: "default",
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
  // Add these only after the user explicitly reviews and confirms them.
  acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
});
```

Create additional named profiles explicitly, then select one explicitly:

```ts
const created = await configs.createProfile("staging");

await configs.replaceProfile(created.id, {
  name: "staging",
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
  acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
});

await configs.selectProfile(created.id);
```

`replaceProfile()` validates model readiness and optional-configuration
review before persisting the complete replacement body. Invalid models produce
`CONFIG_INCOMPLETE`. Unacknowledged optional settings produce
`CONFIG_REVIEW_REQUIRED`; callers must show its secret-free warnings, obtain
explicit confirmation, and retry `replaceProfile()` with the current warning
IDs. For an existing profile, call
`acknowledgeConfigurationWarnings(profileId, warningIds)` only after the same
explicit confirmation. Warning acknowledgements belong to that profile, and a
full `replaceProfile()` clears them so the edited configuration must be
reviewed again.

`listProfiles()` returns metadata only, together with one explicit
`selectedProfileId`. Use `getProfile(profileId)` where management code needs a
complete secret-bearing document for a chosen ID. `resolveProfileById(profileId)`
now requires an explicit ID and never falls back. Existing profiles without
`ai.modelTiers` remain editable, but their readiness is `invalid`; target
selection is never inferred from provider model-array order.

`replaceProfile()` replaces the complete `ai`, `platforms`, and `plugins`
settings set; it is not a partial merge. The reserved `default` profile may be
configured, but it cannot be renamed or deleted. The registry index format is
version 3 and contains metadata plus `selectedProfileId`. Versions 1 and 2 are
rejected with `CONFIG_UNSUPPORTED_VERSION`; callers must back up the store and
bootstrap a new index. No automatic migration or deletion is performed.

At server startup, `KAGUYA_CONFIG_ROOT` is loaded into a frozen profile
registry. When the store is missing, the selected profile is incomplete, or its
optional warnings are unreviewed, HTTP starts in setup mode so the Web UI can
bootstrap, configure, or repair profiles. Runtime and adapter ingress remain
stopped until the server is restarted. Corrupt stores and unsafe or
inaccessible paths still fail startup and are never overwritten by setup. A
module may request only a `modelTier`; it cannot override the selected profile.
Failure of the selected profile stops runtime startup; there is no fallback to
another profile, provider, or model. The legacy `KAGUYA_LLM_API_KEY`,
`KAGUYA_LLM_BASE_URL`, and `KAGUYA_LLM_MODEL` variables are rejected with a
value-free migration error.

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
