# User configuration management

## Summary

`@kaguya/config` stores multiple AI, platform, and plugin configurations. It
provides a default Profile and lookup by an explicit `profileId`; selection is
never inferred from a message source or user identity.

## Current contract

- `inspect()` reports readiness without side effects; `initialize()` explicitly creates the first Profile.
- Index format v2 contains only `defaultProfileId` and Profile metadata. Profile files remain format v1.
- `resolveProfileById(profileId?)` resolves an explicit or default Profile without falling back to another Profile, provider, or model.
- A complete update clears warning acknowledgements, so the edited Profile must be reviewed again.
- Plaintext secrets are written only to permission-protected sensitive JSON files using atomic replacement and path/symlink protection.
- A v1 index is rejected with `CONFIG_UNSUPPORTED_VERSION`. It is never migrated or deleted automatically; back it up and initialize a new index.

## Known limitations

- A configuration root supports only one active writer; cross-process coordination is not implemented.
- Windows deployments must apply NTFS ACLs that restrict access to the runtime identity.
- Configuration UI and secret-manager integration live outside the configuration package.
