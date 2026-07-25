# User Configuration Management Design

**Status:** Approved

**Date:** 2026-07-25

## 1. Goal

Add a reusable user configuration management layer to Kaguya. It must:

- store multiple named configuration profiles;
- keep one complete settings set in each profile;
- let each session select a profile;
- fall back to a default profile when a session has no explicit selection;
- include AI, platform, and plugin configuration fields;
- store secret values as plaintext JSON fields;
- treat the complete configuration directory as sensitive data.

This stage defines and persists configuration fields. It does not connect the
configuration to concrete AI providers, platforms, or plugin runtimes.

## 2. Architecture

Create a new `@kaguya/config` workspace package. It owns configuration schemas,
profile metadata, filesystem persistence, session bindings, profile resolution,
redaction helpers, and typed errors.

The package is independent of the SQLite runtime database and application code.
Callers provide the configuration directory explicitly. Applications may then
use the package without inheriting storage decisions from `@kaguya/database`.

The on-disk layout is:

```text
<config-root>/
├── index.json
└── profiles/
    ├── profile_<uuid>.json
    └── profile_<uuid>.json
```

The complete `<config-root>` directory is sensitive. This includes
`index.json`, because session-to-profile bindings and profile metadata can
reveal operational information.

## 3. Alternatives Considered

### 3.1 Independent `@kaguya/config` package

This is the selected approach. It creates a reusable boundary, keeps plaintext
secret handling in one auditable component, and avoids coupling JSON
configuration files to runtime database records.

### 3.2 Add configuration management to `@kaguya/database`

This would reuse an existing package but would blur the distinction between
JSON user configuration and SQLite runtime state. It would also make
configuration consumers depend on database infrastructure unnecessarily.

### 3.3 Implement configuration inside `apps/demo`

This has the smallest initial footprint but cannot be reused by other
applications and would encourage each app to implement sensitive-file handling
differently.

## 4. Configuration Model

All persisted documents have an integer `version` field. Version 1 uses the
following logical model.

```ts
interface UserConfigProfile {
  version: 1;
  id: string;
  name: string;
  ai: {
    defaultProviderId?: string;
    providers: Array<{
      id: string;
      type: string;
      enabled: boolean;
      baseUrl?: string;
      apiKey?: string;
      models: string[];
      settings: Record<string, unknown>;
    }>;
  };
  platforms: Array<{
    id: string;
    type: string;
    enabled: boolean;
    credentials: Record<string, unknown>;
    settings: Record<string, unknown>;
  }>;
  plugins: Array<{
    id: string;
    enabled: boolean;
    settings: Record<string, unknown>;
  }>;
}
```

`apiKey`, values inside `credentials`, and secret values inside extensible
`settings` objects are stored as plaintext JSON. No environment-variable
indirection or encryption is performed in version 1.

Provider, platform, and plugin IDs must be unique within their respective
arrays. If `defaultProviderId` is present, it must reference an enabled provider
in the same profile.

The index document uses this model:

```ts
interface UserConfigIndex {
  version: 1;
  defaultProfileId: string;
  profiles: Array<{
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  }>;
  sessionBindings: Record<string, string>;
}
```

Profile IDs are generated UUIDs. Display names are trimmed, non-empty, and
unique. File paths are derived only from validated UUIDs, never from profile
names or session IDs.

## 5. Public API

The primary class is `FileUserConfigManager`.

```ts
interface FileUserConfigManagerOptions {
  rootDir: string;
}

class FileUserConfigManager {
  static open(
    options: FileUserConfigManagerOptions,
  ): Promise<FileUserConfigManager>;

  listProfiles(): readonly UserConfigProfileMetadata[];
  getProfile(profileId: string): Promise<UserConfigProfile>;
  createProfile(
    name: string,
    initial?: UserConfigProfileInput,
  ): Promise<UserConfigProfile>;
  updateProfile(
    profileId: string,
    update: UserConfigProfileInput,
  ): Promise<UserConfigProfile>;
  deleteProfile(profileId: string): Promise<void>;

  getDefaultProfileId(): string;
  setDefaultProfile(profileId: string): Promise<void>;

  bindSession(sessionId: string, profileId: string): Promise<void>;
  unbindSession(sessionId: string): Promise<void>;
  resolveProfile(sessionId: string): Promise<UserConfigProfile>;
}
```

`open()` creates an empty store when necessary. A newly created store contains
one profile named `default`. The default profile can be edited but cannot be
renamed or deleted.

`listProfiles()` returns metadata only. It never returns AI keys, platform
credentials, plugin settings, or other profile payloads.

`resolveProfile()` returns the profile bound to the supplied session. If no
binding exists, it returns the current default profile.

Deleting a profile fails when it is the default or when one or more sessions
still reference it. Callers must explicitly unbind those sessions or select a
different default first.

## 6. Validation and Error Semantics

Zod schemas validate all data before it enters the manager and immediately
after JSON is read from disk. Corrupt JSON and schema mismatches fail closed;
the manager does not silently discard a profile or regenerate an index.

The package exports typed errors with stable error codes:

- `CONFIG_INVALID_INPUT`
- `CONFIG_PROFILE_NOT_FOUND`
- `CONFIG_PROFILE_NAME_CONFLICT`
- `CONFIG_PROFILE_IN_USE`
- `CONFIG_DEFAULT_PROFILE_PROTECTED`
- `CONFIG_CORRUPT_STORE`
- `CONFIG_UNSAFE_PATH`
- `CONFIG_PERMISSION_ERROR`
- `CONFIG_IO_ERROR`

Errors may contain the profile ID or affected path, but never include serialized
profile data, keys, credentials, or settings values.

Returned profiles are detached copies. Mutating a returned object does not
modify manager state or persisted data.

## 7. Sensitive File Handling

### 7.1 Permissions

On POSIX systems:

- create the root and `profiles` directories with mode `0700`;
- create index, profile, and temporary files with mode `0600`;
- reject managed paths that are not owned by the current user.
- after confirming ownership and path safety, correct existing managed files
  and directories to the required modes when opening the store.

Node.js does not provide equivalent owner/group/other permission control on
Windows. The package documents that deployment owners must apply restrictive
NTFS ACLs. It does not claim that POSIX modes secure Windows files.

### 7.2 Symlink and Path Safety

The manager checks each managed directory and file with `lstat` and rejects
symbolic links. It validates profile IDs before deriving file paths and checks
that resolved paths stay within the configured root.

Temporary filenames contain generated random identifiers and are created with
exclusive-create semantics. User-controlled profile names and session IDs never
become filenames.

### 7.3 Atomic and Serialized Writes

Every JSON update uses this sequence:

1. validate and serialize the complete new document;
2. open a unique temporary file in the destination directory using exclusive
   creation and mode `0600`;
3. write the complete JSON document;
4. synchronize the file contents;
5. close the temporary file;
6. atomically rename it over the destination;
7. synchronize the parent directory where supported.

All mutations in one manager instance run through a single asynchronous write
queue. A mutation that changes both a profile and the index writes the profile
first and index second. The index never points to a profile file that has not
been durably written.

The package does not promise safe coordination between multiple processes
writing the same directory in version 1. Deployments must use one writer per
configuration root.

### 7.4 Logging and Redaction

The manager does not log persisted documents. It exports a redaction helper for
diagnostics and UI previews. The helper:

- replaces `apiKey` values with `"[REDACTED]"`;
- recursively redacts keys whose normalized names match common secret terms
  such as `token`, `secret`, `password`, `credential`, `privateKey`, and
  `accessKey`;
- returns a new object rather than mutating its input.

Metadata-only methods are preferred wherever callers do not need full runtime
configuration.

### 7.5 Source Control and Backup

The repository ignores the local configuration directory explicitly. Tests use
temporary directories and synthetic placeholder credentials. No real profile
or secret-bearing fixture is committed.

Ignore rules are a guardrail, not a security boundary. If a secret is committed,
the response order is:

1. revoke or rotate the secret;
2. assess access and usage;
3. remove the data from repository history where required;
4. notify affected operators.

Backups and copied profile files remain sensitive. Operators must restrict and
encrypt backups. Automated backup, rotation, and vault integration are outside
this version.

## 8. Threat Model

Version 1 protects against:

- accidental source-control inclusion;
- overly broad POSIX permissions on managed paths;
- partial files caused by interrupted writes;
- path traversal and symlink substitution within managed paths;
- accidental secret exposure through list operations and manager-generated
  errors;
- concurrent mutations within one process.

Version 1 does not protect against:

- another process running as the same operating-system user;
- an administrator or root user;
- host compromise, memory inspection, or malicious dependencies;
- storage-device theft without full-disk encryption;
- multiple processes concurrently writing the same configuration root;
- improper Windows ACL configuration.

Plaintext storage is an explicit product decision. Future encryption-at-rest,
system keychain, or external secrets-manager support requires a separate
versioned design.

## 9. AstrBot Alignment

The design follows AstrBot's useful profile-management semantics:

- multiple configurations have stable IDs and human-readable names;
- a default configuration always exists;
- sessions can resolve a selected configuration with default fallback;
- non-default profile files are stored separately;
- writes use temporary files, synchronization, and replacement.

Kaguya strengthens the sensitive-file boundary by specifying restrictive
permissions, symlink rejection, metadata-only listing, redaction, and explicit
plaintext threat-model documentation.

## 10. Testing Strategy

Tests use isolated temporary directories and cover:

- first-open creation of the default profile and index;
- profile create, list, read, update, rename restrictions, and delete;
- unique-name and UUID validation;
- default fallback and explicit session selection;
- binding, unbinding, and in-use deletion rejection;
- round-trip persistence of plaintext AI keys and platform credentials;
- schema rejection for malformed profile and index files;
- failure on corrupt JSON instead of silent reset;
- POSIX directory and file modes;
- symlink rejection and path containment;
- atomic replacement behavior when a write fails before rename;
- serialization of concurrent mutations in one process;
- metadata-only list results and recursive redaction;
- detached return values;
- no secret values in thrown error messages.

Package-level type checking and tests must pass from the monorepo root alongside
the existing workspace checks.

## 11. Documentation

`CONTRIBUTING.md` will document:

- how to choose a configuration root for local development;
- why the directory must remain outside source control;
- expected POSIX permissions and the Windows ACL limitation;
- safe synthetic test values;
- secret rotation and repository-leak response;
- the single-writer limitation.

A short package README will document the API, JSON examples containing only
placeholder secrets, and the plaintext-storage warning.
