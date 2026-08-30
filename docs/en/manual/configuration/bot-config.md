# User configuration management

## Summary

`@kaguya/config` stores multiple AI, platform, and plugin configurations and
tracks one explicit `selectedProfileId` in a v3 registry. Configuration
selection is never inferred from a message source, user identity, or module
parameter.

## Current contract

- `inspect()` reports readiness without side effects, and `bootstrap()`
  explicitly creates an empty registry with the reserved `default` Profile.
- Index format v3 stores `selectedProfileId` and Profile metadata. Profile
  files remain format v1.
- `resolveProfileById(profileId)` always requires an explicit ID and never
  falls back to another Profile, provider, or model.
- The reserved `default` Profile always exists, cannot be renamed, and cannot
  be deleted.
- Creating a Profile, replacing a full Profile body, selecting the global
  Profile, and deleting a Profile are separate explicit operations.
- A complete replacement clears warning acknowledgements, so the edited Profile
  must be reviewed again.
- Plaintext secrets are written only to permission-protected sensitive JSON
  files using atomic replacement and path/symlink protection.
- v1 and v2 indexes are rejected with `CONFIG_UNSUPPORTED_VERSION`. They are
  never migrated or deleted automatically; back them up and bootstrap a new
  registry.

## Known limitations

- A configuration root supports only one active writer; cross-process coordination is not implemented.
- Windows deployments must apply NTFS ACLs that restrict access to the runtime identity.
- Configuration UI and secret-manager integration live outside the configuration package.
