# @kaguya/config

`@kaguya/config` stores multiple user configuration profiles as JSON and
resolves a profile for each session.

> Profile JSON contains plaintext API keys and credentials. Treat the complete
> configuration root as sensitive data. Do not commit, log, attach, or publish
> it.

## Example

```ts
import { FileUserConfigManager } from "@kaguya/config";

const configs = await FileUserConfigManager.open({
  rootDir: ".data/kaguya-config",
});

const profile = await configs.createProfile("local", {
  ai: {
    defaultProviderId: "local-provider",
    providers: [
      {
        id: "local-provider",
        type: "openai-compatible",
        enabled: true,
        baseUrl: "https://model.example/v1",
        apiKey: "test-only-placeholder",
        models: ["model-a"],
        settings: {},
      },
    ],
  },
  platforms: [],
  plugins: [],
});

await configs.bindSession("session-1", profile.id);
const selected = await configs.resolveProfile("session-1");
```

`listProfiles()` returns metadata only. Use `getProfile()` or
`resolveProfile()` only where runtime code needs the complete secret-bearing
configuration.

## Storage boundary

- POSIX directories are corrected to `0700`; managed files are corrected to
  `0600`.
- Managed symlinks and paths outside the root are rejected.
- Writes use a synchronized temporary file and atomic replacement.
- One process may write a configuration root. Cross-process locking is not
  provided.
- Windows deployments must apply restrictive NTFS ACLs; POSIX modes do not
  provide an equivalent Windows guarantee.
- Plaintext storage does not protect against the same OS user, administrators,
  host compromise, memory inspection, or unencrypted device theft.

If a real secret enters Git, revoke or rotate it first. Then assess exposure and
remove it from repository history where required.
