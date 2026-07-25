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

`updateProfile()` replaces the complete `ai`, `platforms`, and `plugins`
settings set; it is not a partial merge. The current default profile may be
edited, but it cannot be renamed or deleted. A profile selected by any session
cannot be deleted until every such session is explicitly unbound or rebound.

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
