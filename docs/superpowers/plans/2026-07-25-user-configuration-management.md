# User Configuration Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable `@kaguya/config` package that stores multiple plaintext-secret JSON profiles safely and resolves a per-session selection with default fallback.

**Architecture:** The package owns its Zod contracts, redaction, secure filesystem primitives, and `FileUserConfigManager`. Profiles are UUID-named JSON files; a sensitive index stores metadata, the default profile, and session bindings. All mutation paths validate first, serialize through one in-process queue, and use owner-only atomic file replacement.

**Tech Stack:** TypeScript 6 strict ESM, Node.js 24 `fs/promises` and `crypto`, Zod 4.4.3, Vitest 4.1.10, pnpm 11.9.0.

## Global Constraints

- Work on the existing `main` branch; do not create a worktree.
- Store API keys and platform/plugin secrets as plaintext JSON fields.
- Treat the complete configuration root, including `index.json`, as sensitive.
- Use one JSON file per profile and generated UUIDs for profile filenames.
- Resolve configuration per session and fall back to a configurable default profile.
- Each profile contains AI, platform, and plugin fields; runtime adapters remain outside this scope.
- Keep `@kaguya/config` independent of `@kaguya/database`, apps, and provider SDKs.
- Support one writer process per configuration root; serialize mutations within one manager instance.
- On POSIX, enforce directory mode `0700`, file mode `0600`, current-user ownership, and symlink rejection.
- Do not claim POSIX mode protection on Windows; document the NTFS ACL responsibility.
- Never include profile payloads or secret values in manager-produced logs or errors.
- Do not add or modify the existing untracked `docs/SDK.md`.
- Follow RED, GREEN, REFACTOR and make one focused commit per task.

---

## File Structure

```text
packages/config/
├── README.md                 public API, plaintext warning, safe examples
├── package.json              workspace package metadata and Zod dependency
├── tsconfig.json             composite TypeScript project
└── src/
    ├── errors.ts             stable ConfigError codes
    ├── index.ts              public exports only
    ├── manager.test.ts       profile lifecycle and session resolution
    ├── manager.ts            FileUserConfigManager and write queue
    ├── model.test.ts         schema invariants
    ├── model.ts              persisted models, inputs, schemas, empty settings
    ├── redact.test.ts        recursive redaction behavior
    ├── redact.ts             detached redacted diagnostic copies
    ├── secure-files.test.ts  permissions, symlinks, and atomic replacement
    └── secure-files.ts       sensitive directory and JSON file primitives
```

Existing files modified:

```text
.gitignore                 explicit local sensitive configuration ignore
CONTRIBUTING.md            local path, permissions, leak response, limitations
README.md                  package inventory and feature summary
docs/architecture.md       package responsibility and dependency diagram
pnpm-lock.yaml             packages/config importer
tsconfig.json              packages/config project reference
```

`model.ts` contains no filesystem behavior. `secure-files.ts` knows nothing
about profile semantics. `manager.ts` composes both boundaries and is the only
place that coordinates profile and index changes.

---

### Task 1: Package Scaffold, Configuration Contracts, and Typed Errors

**Files:**

- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/src/model.ts`
- Create: `packages/config/src/model.test.ts`
- Create: `packages/config/src/errors.ts`
- Create: `packages/config/src/index.ts`
- Modify: `tsconfig.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Zod `4.4.3`.
- Produces: `UserConfigProfile`, `UserConfigProfileSettings`,
  `UpdateUserConfigProfileInput`, `UserConfigProfileMetadata`,
  `UserConfigIndex`, their schemas, `emptyUserConfigProfileSettings()`,
  `ConfigError`, and `ConfigErrorCode`.

- [ ] **Step 1: Write failing schema tests**

Create `packages/config/src/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  userConfigIndexSchema,
  userConfigProfileSchema,
  userConfigProfileSettingsSchema,
} from "./model.js";

const profileId = "4f649709-50d9-4fc4-8df4-95f96163f7c9";

describe("user configuration schemas", () => {
  it("preserves plaintext AI and platform credentials", () => {
    const profile = userConfigProfileSchema.parse({
      version: 1,
      id: profileId,
      name: "personal",
      ai: {
        defaultProviderId: "provider-1",
        providers: [
          {
            id: "provider-1",
            type: "openai-compatible",
            enabled: true,
            baseUrl: "https://model.example/v1",
            apiKey: "test-ai-key",
            models: ["model-a"],
            settings: { organization: "test-org" },
          },
        ],
      },
      platforms: [
        {
          id: "platform-1",
          type: "discord",
          enabled: true,
          credentials: { token: "test-platform-token" },
          settings: { guild: "test-guild" },
        },
      ],
      plugins: [
        {
          id: "plugin-1",
          enabled: true,
          settings: { accessToken: "test-plugin-token" },
        },
      ],
    });

    expect(profile.ai.providers[0]?.apiKey).toBe("test-ai-key");
    expect(profile.platforms[0]?.credentials).toEqual({
      token: "test-platform-token",
    });
  });

  it("rejects duplicate IDs and a disabled default provider", () => {
    const duplicateProvider = {
      id: "provider-1",
      type: "openai-compatible",
      enabled: true,
      models: [],
      settings: {},
    };

    expect(() =>
      userConfigProfileSettingsSchema.parse({
        ai: {
          defaultProviderId: "provider-1",
          providers: [
            duplicateProvider,
            { ...duplicateProvider, enabled: false },
          ],
        },
        platforms: [],
        plugins: [],
      }),
    ).toThrow();

    expect(() =>
      userConfigProfileSettingsSchema.parse({
        ai: {
          defaultProviderId: "provider-1",
          providers: [{ ...duplicateProvider, enabled: false }],
        },
        platforms: [],
        plugins: [],
      }),
    ).toThrow();
  });

  it("rejects an index whose default and bindings reference missing profiles", () => {
    expect(() =>
      userConfigIndexSchema.parse({
        version: 1,
        defaultProfileId: profileId,
        profiles: [],
        sessionBindings: {
          "session-1": profileId,
        },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
pnpm vitest run packages/config/src/model.test.ts
```

Expected: FAIL because `packages/config/src/model.ts` does not exist.

- [ ] **Step 3: Add the workspace package**

Create `packages/config/package.json`:

```json
{
  "name": "@kaguya/config",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false"
  },
  "dependencies": {
    "zod": "4.4.3"
  }
}
```

Create `packages/config/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

Add `{ "path": "./packages/config" }` immediately after the schema reference in
root `tsconfig.json`, then run:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` gains a `packages/config` importer with Zod 4.4.3.

- [ ] **Step 4: Implement stable error types**

Create `packages/config/src/errors.ts`:

```ts
export const configErrorCodes = [
  "CONFIG_INVALID_INPUT",
  "CONFIG_PROFILE_NOT_FOUND",
  "CONFIG_PROFILE_NAME_CONFLICT",
  "CONFIG_PROFILE_IN_USE",
  "CONFIG_DEFAULT_PROFILE_PROTECTED",
  "CONFIG_CORRUPT_STORE",
  "CONFIG_UNSAFE_PATH",
  "CONFIG_PERMISSION_ERROR",
  "CONFIG_IO_ERROR",
] as const;

export type ConfigErrorCode = (typeof configErrorCodes)[number];

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  override readonly cause: unknown;

  constructor(
    code: ConfigErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ConfigError";
    this.code = code;
    this.cause = options.cause;
  }
}
```

Manager and filesystem code may include a path or profile ID in messages, but
must use fixed validation messages and must not attach Zod errors as `cause`,
because validation issues can contain rejected secret values.

- [ ] **Step 5: Implement the schemas and inferred types**

Create `packages/config/src/model.ts` with:

```ts
import { z } from "zod";

const nonEmptyIdSchema = z.string().trim().min(1);
const settingsSchema = z.record(z.string(), z.unknown());
export const profileIdSchema = z.uuid();

export const aiProviderConfigSchema = z.strictObject({
  id: nonEmptyIdSchema,
  type: nonEmptyIdSchema,
  enabled: z.boolean(),
  baseUrl: z.url().optional(),
  apiKey: z.string().optional(),
  models: z.array(nonEmptyIdSchema),
  settings: settingsSchema,
});

export const aiConfigSchema = z
  .strictObject({
    defaultProviderId: nonEmptyIdSchema.optional(),
    providers: z.array(aiProviderConfigSchema),
  })
  .superRefine((ai, context) => {
    addDuplicateIdIssues(ai.providers, "provider", ["providers"], context);
    if (
      ai.defaultProviderId !== undefined &&
      !ai.providers.some(
        (provider) => provider.id === ai.defaultProviderId && provider.enabled,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultProviderId"],
        message: "defaultProviderId must reference an enabled provider",
      });
    }
  });

export const platformConfigSchema = z.strictObject({
  id: nonEmptyIdSchema,
  type: nonEmptyIdSchema,
  enabled: z.boolean(),
  credentials: settingsSchema,
  settings: settingsSchema,
});

export const pluginConfigSchema = z.strictObject({
  id: nonEmptyIdSchema,
  enabled: z.boolean(),
  settings: settingsSchema,
});

export const userConfigProfileSettingsSchema = z
  .strictObject({
    ai: aiConfigSchema,
    platforms: z.array(platformConfigSchema),
    plugins: z.array(pluginConfigSchema),
  })
  .superRefine((settings, context) => {
    addDuplicateIdIssues(
      settings.platforms,
      "platform",
      ["platforms"],
      context,
    );
    addDuplicateIdIssues(settings.plugins, "plugin", ["plugins"], context);
  });

export const userConfigProfileSchema =
  userConfigProfileSettingsSchema.safeExtend({
    version: z.literal(1),
    id: profileIdSchema,
    name: z.string().trim().min(1),
  });

export const userConfigProfileMetadataSchema = z.strictObject({
  id: profileIdSchema,
  name: z.string().trim().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const userConfigIndexSchema = z
  .strictObject({
    version: z.literal(1),
    defaultProfileId: profileIdSchema,
    profiles: z.array(userConfigProfileMetadataSchema),
    sessionBindings: z.record(z.string(), profileIdSchema),
  })
  .superRefine((index, context) => {
    const profileIds = new Set(index.profiles.map(({ id }) => id));
    const profileNames = new Set<string>();
    if (!profileIds.has(index.defaultProfileId)) {
      context.addIssue({
        code: "custom",
        path: ["defaultProfileId"],
        message: "defaultProfileId must reference a profile",
      });
    }
    for (const [position, profile] of index.profiles.entries()) {
      if (
        index.profiles.findIndex(({ id }) => id === profile.id) !== position
      ) {
        context.addIssue({
          code: "custom",
          path: ["profiles", position, "id"],
          message: "profile IDs must be unique",
        });
      }
      if (profileNames.has(profile.name)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", position, "name"],
          message: "profile names must be unique",
        });
      }
      profileNames.add(profile.name);
    }
    for (const [sessionId, profileId] of Object.entries(
      index.sessionBindings,
    )) {
      if (sessionId.trim().length === 0 || !profileIds.has(profileId)) {
        context.addIssue({
          code: "custom",
          path: ["sessionBindings", sessionId],
          message: "session binding must reference a profile",
        });
      }
    }
  });

function addDuplicateIdIssues(
  entries: readonly { id: string }[],
  kind: string,
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [position, entry] of entries.entries()) {
    if (seen.has(entry.id)) {
      context.addIssue({
        code: "custom",
        path: [...path, position, "id"],
        message: `${kind} IDs must be unique`,
      });
    }
    seen.add(entry.id);
  }
}

export type UserConfigProfile = z.infer<typeof userConfigProfileSchema>;
export type UserConfigProfileSettings = z.infer<
  typeof userConfigProfileSettingsSchema
>;
export type UserConfigProfileMetadata = z.infer<
  typeof userConfigProfileMetadataSchema
>;
export type UserConfigIndex = z.infer<typeof userConfigIndexSchema>;

export type UpdateUserConfigProfileInput = UserConfigProfileSettings & {
  name?: string;
};

export function emptyUserConfigProfileSettings(): UserConfigProfileSettings {
  return {
    ai: { providers: [] },
    platforms: [],
    plugins: [],
  };
}
```

- [ ] **Step 6: Add the initial public exports**

Create `packages/config/src/index.ts`:

```ts
export { ConfigError, configErrorCodes } from "./errors.js";
export type { ConfigErrorCode } from "./errors.js";
export {
  aiConfigSchema,
  aiProviderConfigSchema,
  emptyUserConfigProfileSettings,
  platformConfigSchema,
  pluginConfigSchema,
  userConfigIndexSchema,
  userConfigProfileMetadataSchema,
  userConfigProfileSchema,
  userConfigProfileSettingsSchema,
} from "./model.js";
export type {
  UpdateUserConfigProfileInput,
  UserConfigIndex,
  UserConfigProfile,
  UserConfigProfileMetadata,
  UserConfigProfileSettings,
} from "./model.js";
```

- [ ] **Step 7: Run focused verification and commit**

Run:

```bash
pnpm vitest run packages/config/src/model.test.ts
pnpm --filter @kaguya/config typecheck
git diff --check
```

Expected: all schema tests pass, typecheck exits 0, and the diff check is clean.

Commit:

```bash
git add packages/config tsconfig.json pnpm-lock.yaml
git commit -m "feat(config): define user configuration contracts"
```

---

### Task 2: Detached Recursive Secret Redaction

**Files:**

- Create: `packages/config/src/redact.ts`
- Create: `packages/config/src/redact.test.ts`
- Modify: `packages/config/src/index.ts`

**Interfaces:**

- Consumes: arbitrary JSON-compatible values.
- Produces: `redactConfigValue<T>(value: T): T` and
  `REDACTED_CONFIG_VALUE`.

- [ ] **Step 1: Write failing redaction tests**

Create `packages/config/src/redact.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { REDACTED_CONFIG_VALUE, redactConfigValue } from "./redact.js";

describe("redactConfigValue", () => {
  it("recursively removes common secret fields without mutating input", () => {
    const source = {
      apiKey: "ai-secret",
      nested: {
        access_token: "access-secret",
        harmless: "visible",
      },
      platforms: [
        {
          credentials: {
            password: "platform-secret",
          },
        },
      ],
    };

    expect(redactConfigValue(source)).toEqual({
      apiKey: REDACTED_CONFIG_VALUE,
      nested: {
        access_token: REDACTED_CONFIG_VALUE,
        harmless: "visible",
      },
      platforms: [{ credentials: REDACTED_CONFIG_VALUE }],
    });
    expect(source.apiKey).toBe("ai-secret");
    expect(source.platforms[0]?.credentials.password).toBe("platform-secret");
  });

  it("returns detached arrays and non-secret objects", () => {
    const source = { values: [{ enabled: true }] };
    const redacted = redactConfigValue(source);

    redacted.values[0]!.enabled = false;
    expect(source.values[0]?.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm vitest run packages/config/src/redact.test.ts
```

Expected: FAIL because `redact.ts` does not exist.

- [ ] **Step 3: Implement recursive redaction**

Create `packages/config/src/redact.ts`:

```ts
export const REDACTED_CONFIG_VALUE = "[REDACTED]";

const secretTerms = [
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
  "privatekey",
  "accesskey",
];

export function redactConfigValue<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSecretKey(key) ? REDACTED_CONFIG_VALUE : redact(entry),
      ]),
    );
  }
  return value;
}

function isSecretKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return secretTerms.some((term) => normalized.includes(term));
}
```

Export both symbols from `packages/config/src/index.ts`.

- [ ] **Step 4: Run focused verification and commit**

Run:

```bash
pnpm vitest run packages/config/src/redact.test.ts
pnpm --filter @kaguya/config typecheck
git diff --check
```

Expected: two redaction tests pass and typecheck exits 0.

Commit:

```bash
git add packages/config/src/redact.ts packages/config/src/redact.test.ts packages/config/src/index.ts
git commit -m "feat(config): redact sensitive configuration values"
```

---

### Task 3: Sensitive Directory and Atomic JSON Primitives

**Files:**

- Create: `packages/config/src/secure-files.ts`
- Create: `packages/config/src/secure-files.test.ts`

**Interfaces:**

- Consumes: absolute or relative caller-provided paths after resolution.
- Produces internally:
  `ensureSensitiveDirectory(path)`,
  `readSensitiveJson(path)`,
  `writeSensitiveJson(path, value, hooks?)`,
  `removeSensitiveFile(path)`, and
  `assertPathInside(root, candidate)`.
- These helpers are not re-exported from the package public entry point.

- [ ] **Step 1: Write failing sensitive-file tests**

Create `packages/config/src/secure-files.test.ts`:

```ts
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigError } from "./errors.js";
import {
  assertPathInside,
  ensureSensitiveDirectory,
  readSensitiveJson,
  writeSensitiveJson,
} from "./secure-files.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaguya-config-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("sensitive file primitives", () => {
  it.runIf(process.platform !== "win32")(
    "enforces owner-only directory and file modes",
    async () => {
      const root = await temporaryRoot();
      const directory = join(root, "profiles");
      const file = join(directory, "index.json");

      await ensureSensitiveDirectory(directory);
      await writeSensitiveJson(file, { version: 1 });
      await chmod(directory, 0o755);
      await chmod(file, 0o644);
      await ensureSensitiveDirectory(directory);
      await readSensitiveJson(file);

      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
    },
  );

  it("keeps the destination unchanged when failure occurs before rename", async () => {
    const root = await temporaryRoot();
    const file = join(root, "index.json");
    await writeSensitiveJson(file, { value: "original" });

    await expect(
      writeSensitiveJson(
        file,
        { value: "replacement" },
        {
          beforeRename: () => {
            throw new Error("injected failure");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "CONFIG_IO_ERROR" });

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      value: "original",
    });
  });

  it("rejects symlinked managed files", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target.json");
    const link = join(root, "index.json");
    await writeFile(target, "{}");
    await symlink(target, link);

    await expect(readSensitiveJson(link)).rejects.toMatchObject({
      code: "CONFIG_UNSAFE_PATH",
    } satisfies Partial<ConfigError>);
  });

  it("rejects paths outside the configured root", async () => {
    const root = await temporaryRoot();
    expect(() => assertPathInside(root, join(root, "..", "outside"))).toThrow(
      expect.objectContaining({ code: "CONFIG_UNSAFE_PATH" }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
pnpm vitest run packages/config/src/secure-files.test.ts
```

Expected: FAIL because `secure-files.ts` does not exist.

- [ ] **Step 3: Implement path, ownership, and symlink checks**

Create `packages/config/src/secure-files.ts` with these constants and helpers:

```ts
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { ConfigError } from "./errors.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

interface AtomicWriteHooks {
  beforeRename?: (temporaryPath: string) => void | Promise<void>;
}

export function assertPathInside(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const offset = relative(resolvedRoot, resolvedCandidate);
  if (
    offset === "" ||
    (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  ) {
    return;
  }
  throw new ConfigError(
    "CONFIG_UNSAFE_PATH",
    `Managed path escapes configuration root: ${resolvedCandidate}`,
  );
}

async function validateManagedPath(
  path: string,
  expected: "directory" | "file",
): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new ConfigError(
      "CONFIG_UNSAFE_PATH",
      `Managed path must not be a symbolic link: ${path}`,
    );
  }
  const matchesType =
    expected === "directory" ? stats.isDirectory() : stats.isFile();
  if (!matchesType) {
    throw new ConfigError(
      "CONFIG_UNSAFE_PATH",
      `Managed path has an unexpected type: ${path}`,
    );
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stats.uid !== process.getuid()
  ) {
    throw new ConfigError(
      "CONFIG_PERMISSION_ERROR",
      `Managed path is not owned by the current user: ${path}`,
    );
  }
}
```

`assertPathInside` deliberately allows the root itself; manager code will call
it only with the root and its intended children.

- [ ] **Step 4: Implement permission correction and no-follow reads**

Add:

```ts
export async function ensureSensitiveDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    await validateManagedPath(path, "directory");
    if (process.platform !== "win32") {
      await chmod(path, DIRECTORY_MODE);
    }
  } catch (error) {
    throw normalizeFileError("prepare sensitive directory", path, error);
  }
}

export async function readSensitiveJson(path: string): Promise<unknown> {
  try {
    await validateManagedPath(path, "file");
    if (process.platform !== "win32") {
      await chmod(path, FILE_MODE);
    }
    const handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new ConfigError(
        "CONFIG_CORRUPT_STORE",
        `Configuration JSON is invalid: ${path}`,
      );
    }
    throw normalizeFileError("read sensitive JSON", path, error);
  }
}
```

- [ ] **Step 5: Implement atomic replacement and cleanup**

Add:

```ts
export async function writeSensitiveJson(
  path: string,
  value: unknown,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await ensureSensitiveDirectory(directory);
    try {
      await validateManagedPath(path, "file");
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    handle = await open(temporaryPath, "wx", FILE_MODE);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeRename?.(temporaryPath);
    await rename(temporaryPath, path);
    if (process.platform !== "win32") {
      await chmod(path, FILE_MODE);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof ConfigError) {
      throw error;
    }
    throw normalizeFileError("write sensitive JSON", path, error);
  }
}

export async function removeSensitiveFile(path: string): Promise<void> {
  try {
    await validateManagedPath(path, "file");
    await unlink(path);
  } catch (error) {
    throw normalizeFileError("remove sensitive file", path, error);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function normalizeFileError(
  action: string,
  path: string,
  error: unknown,
): ConfigError {
  if (error instanceof ConfigError) {
    return error;
  }
  const permissionDenied =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM");
  return new ConfigError(
    permissionDenied ? "CONFIG_PERMISSION_ERROR" : "CONFIG_IO_ERROR",
    `Failed to ${action}: ${path}`,
    { cause: error },
  );
}
```

`validateManagedPath` intentionally has no catch boundary, so an `ENOENT` from
`lstat` reaches `writeSensitiveJson` unchanged and is recognized by
`isMissingFileError`.

- [ ] **Step 6: Run focused verification and commit**

Run:

```bash
pnpm vitest run packages/config/src/secure-files.test.ts
pnpm --filter @kaguya/config typecheck
pnpm lint
git diff --check
```

Expected: four secure-file tests pass on POSIX; Windows skips only the mode
assertion. Typecheck, lint, and diff check exit 0.

Commit:

```bash
git add packages/config/src/secure-files.ts packages/config/src/secure-files.test.ts
git commit -m "feat(config): persist sensitive JSON atomically"
```

---

### Task 4: Profile Store Initialization and Lifecycle

**Files:**

- Create: `packages/config/src/manager.ts`
- Create: `packages/config/src/manager.test.ts`
- Modify: `packages/config/src/index.ts`

**Interfaces:**

- Consumes: schemas from `model.ts` and filesystem helpers from
  `secure-files.ts`.
- Produces:
  `FileUserConfigManager.open({ rootDir })`,
  `listProfiles()`,
  `getProfile(id)`,
  `createProfile(name, initial?)`,
  `updateProfile(id, update)`,
  `deleteProfile(id)`,
  `getDefaultProfileId()`, and
  `setDefaultProfile(id)`.

- [ ] **Step 1: Write failing initialization and lifecycle tests**

Create `packages/config/src/manager.test.ts` with a temporary-root helper and
these first tests:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileUserConfigManager } from "./manager.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaguya-config-manager-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("FileUserConfigManager profile lifecycle", () => {
  it("creates and reopens one protected default profile", async () => {
    const rootDir = await createRoot();
    const first = await FileUserConfigManager.open({ rootDir });
    const metadata = first.listProfiles();

    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.name).toBe("default");
    expect(first.getDefaultProfileId()).toBe(metadata[0]?.id);
    await expect(first.getProfile(metadata[0]!.id)).resolves.toMatchObject({
      version: 1,
      name: "default",
      ai: { providers: [] },
      platforms: [],
      plugins: [],
    });

    const reopened = await FileUserConfigManager.open({ rootDir });
    expect(reopened.listProfiles()).toEqual(metadata);
  });

  it("round-trips plaintext secrets and returns detached values", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const created = await manager.createProfile("work", {
      ai: {
        defaultProviderId: "provider-1",
        providers: [
          {
            id: "provider-1",
            type: "openai-compatible",
            enabled: true,
            apiKey: "test-plaintext-key",
            models: ["model-a"],
            settings: {},
          },
        ],
      },
      platforms: [],
      plugins: [],
    });

    expect((await manager.getProfile(created.id)).ai.providers[0]?.apiKey).toBe(
      "test-plaintext-key",
    );
    created.ai.providers[0]!.apiKey = "mutated";
    expect((await manager.getProfile(created.id)).ai.providers[0]?.apiKey).toBe(
      "test-plaintext-key",
    );
    expect(
      await readFile(
        join(manager.rootDir, "profiles", `profile_${created.id}.json`),
        "utf8",
      ),
    ).toContain("test-plaintext-key");
    expect(JSON.stringify(manager.listProfiles())).not.toContain(
      "test-plaintext-key",
    );
  });

  it("updates complete settings and enforces unique trimmed names", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const work = await manager.createProfile(" work ");
    await manager.createProfile("personal");

    await expect(
      manager.updateProfile(work.id, {
        name: "personal",
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_PROFILE_NAME_CONFLICT" });

    await expect(
      manager.updateProfile(work.id, {
        name: "renamed",
        ai: { providers: [] },
        platforms: [],
        plugins: [{ id: "plugin-1", enabled: false, settings: {} }],
      }),
    ).resolves.toMatchObject({
      name: "renamed",
      plugins: [{ id: "plugin-1", enabled: false }],
    });
  });

  it("protects the current default and deletes an unused non-default profile", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const defaultId = manager.getDefaultProfileId();
    const removable = await manager.createProfile("removable");

    await expect(manager.deleteProfile(defaultId)).rejects.toMatchObject({
      code: "CONFIG_DEFAULT_PROFILE_PROTECTED",
    });
    await expect(
      manager.updateProfile(defaultId, {
        name: "renamed-default",
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_DEFAULT_PROFILE_PROTECTED",
    });
    await manager.deleteProfile(removable.id);
    await expect(manager.getProfile(removable.id)).rejects.toMatchObject({
      code: "CONFIG_PROFILE_NOT_FOUND",
    });
  });

  it("changes the default to an existing profile", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const originalDefaultId = manager.getDefaultProfileId();
    const replacement = await manager.createProfile("replacement");

    await manager.setDefaultProfile(replacement.id);
    expect(manager.getDefaultProfileId()).toBe(replacement.id);
    await expect(manager.deleteProfile(replacement.id)).rejects.toMatchObject({
      code: "CONFIG_DEFAULT_PROFILE_PROTECTED",
    });
    await expect(
      manager.deleteProfile(originalDefaultId),
    ).resolves.toBeUndefined();
  });
});
```

Expose `readonly rootDir: string` on the manager so diagnostics and callers can
show the resolved sensitive root without exposing profile content.

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
pnpm vitest run packages/config/src/manager.test.ts
```

Expected: FAIL because `manager.ts` does not exist.

- [ ] **Step 3: Implement initialization and safe parsing**

Create `packages/config/src/manager.ts` with these imports and helpers:

```ts
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ConfigError } from "./errors.js";
import {
  emptyUserConfigProfileSettings,
  profileIdSchema,
  type UpdateUserConfigProfileInput,
  type UserConfigIndex,
  type UserConfigProfile,
  type UserConfigProfileMetadata,
  type UserConfigProfileSettings,
  userConfigIndexSchema,
  userConfigProfileSchema,
  userConfigProfileSettingsSchema,
} from "./model.js";
import {
  assertPathInside,
  ensureSensitiveDirectory,
  readSensitiveJson,
  removeSensitiveFile,
  writeSensitiveJson,
} from "./secure-files.js";

export interface FileUserConfigManagerOptions {
  rootDir: string;
}

export class FileUserConfigManager {
  readonly rootDir: string;
  readonly #profilesDir: string;
  readonly #indexPath: string;
  #index: UserConfigIndex;

  private constructor(rootDir: string, index: UserConfigIndex) {
    this.rootDir = rootDir;
    this.#profilesDir = join(rootDir, "profiles");
    this.#indexPath = join(rootDir, "index.json");
    this.#index = index;
  }

  static async open(
    options: FileUserConfigManagerOptions,
  ): Promise<FileUserConfigManager> {
    const rootDir = resolve(options.rootDir);
    if (options.rootDir.trim().length === 0) {
      throw new ConfigError(
        "CONFIG_INVALID_INPUT",
        "Configuration root must not be empty",
      );
    }
    const profilesDir = join(rootDir, "profiles");
    const indexPath = join(rootDir, "index.json");
    assertPathInside(rootDir, profilesDir);
    assertPathInside(rootDir, indexPath);
    await ensureSensitiveDirectory(rootDir);
    await ensureSensitiveDirectory(profilesDir);

    let index: UserConfigIndex;
    try {
      await access(indexPath);
      index = parsePersistedIndex(
        await readSensitiveJson(indexPath),
        indexPath,
      );
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
      index = await createInitialStore(profilesDir, indexPath);
    }

    const manager = new FileUserConfigManager(rootDir, index);
    await manager.#validateReferencedProfiles();
    return manager;
  }
}
```

Add `isMissingPath`, `parsePersistedIndex`, `parsePersistedProfile`,
`createInitialStore`, `profilePath`, and `#validateReferencedProfiles`.
Use `safeParse`; throw fixed `CONFIG_CORRUPT_STORE` messages without a Zod
`cause`:

```ts
function parsePersistedIndex(value: unknown, path: string): UserConfigIndex {
  const parsed = userConfigIndexSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      "CONFIG_CORRUPT_STORE",
      `Configuration index failed validation: ${path}`,
    );
  }
  return parsed.data;
}

function parsePersistedProfile(
  value: unknown,
  path: string,
): UserConfigProfile {
  const parsed = userConfigProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      "CONFIG_CORRUPT_STORE",
      `Configuration profile failed validation: ${path}`,
    );
  }
  return parsed.data;
}
```

`createInitialStore` must generate one UUID, use one ISO timestamp for
`createdAt` and `updatedAt`, write the default profile first, then write the
index:

```ts
async function createInitialStore(
  profilesDir: string,
  indexPath: string,
): Promise<UserConfigIndex> {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const profile: UserConfigProfile = {
    version: 1,
    id,
    name: "default",
    ...emptyUserConfigProfileSettings(),
  };
  const index: UserConfigIndex = {
    version: 1,
    defaultProfileId: id,
    profiles: [
      { id, name: "default", createdAt: timestamp, updatedAt: timestamp },
    ],
    sessionBindings: {},
  };
  await writeSensitiveJson(join(profilesDir, `profile_${id}.json`), profile);
  await writeSensitiveJson(indexPath, index);
  return index;
}
```

On open, load every index metadata entry, validate the filename-derived
profile, require `profile.id === metadata.id` and
`profile.name === metadata.name`, and throw `CONFIG_CORRUPT_STORE` when either
check fails.

- [ ] **Step 4: Implement read, create, and update**

Add exact public method signatures:

```ts
listProfiles(): readonly UserConfigProfileMetadata[];
getProfile(profileId: string): Promise<UserConfigProfile>;
createProfile(
  name: string,
  initial?: UserConfigProfileSettings,
): Promise<UserConfigProfile>;
updateProfile(
  profileId: string,
  update: UpdateUserConfigProfileInput,
): Promise<UserConfigProfile>;
```

Import `profileIdSchema` from `model.ts`. Use `structuredClone` for every
returned profile and metadata array. Validate UUID parameters before creating
paths. Add these private helpers:

```ts
#requireMetadata(profileId: string): UserConfigProfileMetadata {
  if (!profileIdSchema.safeParse(profileId).success) {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration profile ID is invalid",
    );
  }
  const metadata = this.#index.profiles.find(({ id }) => id === profileId);
  if (metadata === undefined) {
    throw new ConfigError(
      "CONFIG_PROFILE_NOT_FOUND",
      `Configuration profile was not found: ${profileId}`,
    );
  }
  return metadata;
}

#profilePath(profileId: string): string {
  const path = join(this.#profilesDir, `profile_${profileId}.json`);
  assertPathInside(this.rootDir, path);
  return path;
}

async #readProfile(profileId: string): Promise<UserConfigProfile> {
  this.#requireMetadata(profileId);
  const path = this.#profilePath(profileId);
  const profile = parsePersistedProfile(
    await readSensitiveJson(path),
    path,
  );
  if (profile.id !== profileId) {
    throw new ConfigError(
      "CONFIG_CORRUPT_STORE",
      `Configuration profile ID does not match its filename: ${path}`,
    );
  }
  return profile;
}

async #writeIndex(index: UserConfigIndex): Promise<void> {
  const parsed = userConfigIndexSchema.safeParse(index);
  if (!parsed.success) {
    throw new ConfigError(
      "CONFIG_IO_ERROR",
      "Refused to persist an invalid configuration index",
    );
  }
  await writeSensitiveJson(this.#indexPath, parsed.data);
}
```

Implement the read methods:

```ts
listProfiles(): readonly UserConfigProfileMetadata[] {
  return structuredClone(this.#index.profiles);
}

async getProfile(profileId: string): Promise<UserConfigProfile> {
  return structuredClone(await this.#readProfile(profileId));
}
```

Validate settings with a fixed, secret-free error:

```ts
function parseSettings(value: unknown): UserConfigProfileSettings {
  const parsed = userConfigProfileSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration profile input failed validation",
    );
  }
  return parsed.data;
}
```

Normalize the candidate name with:

```ts
function normalizeProfileName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration profile name must not be empty",
    );
  }
  return normalized;
}
```

Implement `createProfile` using this exact state transition:

```ts
async createProfile(
  name: string,
  initial: UserConfigProfileSettings =
    emptyUserConfigProfileSettings(),
): Promise<UserConfigProfile> {
  const normalizedName = normalizeProfileName(name);
  const settings = parseSettings(initial);
  if (this.#index.profiles.some(({ name: current }) => current === normalizedName)) {
    throw new ConfigError(
      "CONFIG_PROFILE_NAME_CONFLICT",
      `Configuration profile name already exists: ${normalizedName}`,
    );
  }

  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const profile: UserConfigProfile = {
    version: 1,
    id,
    name: normalizedName,
    ...settings,
  };
  const nextIndex: UserConfigIndex = {
    ...structuredClone(this.#index),
    profiles: [
      ...structuredClone(this.#index.profiles),
      {
        id,
        name: normalizedName,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
  const path = this.#profilePath(id);
  await writeSensitiveJson(path, profile);
  try {
    await this.#writeIndex(nextIndex);
  } catch (error) {
    await removeSensitiveFile(path);
    throw error;
  }
  this.#index = nextIndex;
  return structuredClone(profile);
}
```

Implement `updateProfile` with complete settings replacement:

```ts
async updateProfile(
  profileId: string,
  update: UpdateUserConfigProfileInput,
): Promise<UserConfigProfile> {
  const metadata = this.#requireMetadata(profileId);
  const oldProfile = await this.#readProfile(profileId);
  const name =
    update.name === undefined
      ? metadata.name
      : normalizeProfileName(update.name);
  if (profileId === this.#index.defaultProfileId && name !== metadata.name) {
    throw new ConfigError(
      "CONFIG_DEFAULT_PROFILE_PROTECTED",
      `The default configuration profile cannot be renamed: ${profileId}`,
    );
  }
  if (
    this.#index.profiles.some(
      ({ id, name: current }) => id !== profileId && current === name,
    )
  ) {
    throw new ConfigError(
      "CONFIG_PROFILE_NAME_CONFLICT",
      `Configuration profile name already exists: ${name}`,
    );
  }
  const settings = parseSettings({
    ai: update.ai,
    platforms: update.platforms,
    plugins: update.plugins,
  });
  const profile: UserConfigProfile = {
    version: 1,
    id: profileId,
    name,
    ...settings,
  };
  const nextIndex: UserConfigIndex = {
    ...structuredClone(this.#index),
    profiles: this.#index.profiles.map((current) =>
      current.id === profileId
        ? { ...current, name, updatedAt: new Date().toISOString() }
        : structuredClone(current),
    ),
  };
  const path = this.#profilePath(profileId);
  await writeSensitiveJson(path, profile);
  try {
    await this.#writeIndex(nextIndex);
  } catch (indexError) {
    try {
      await writeSensitiveJson(path, oldProfile);
    } catch (rollbackError) {
      throw new ConfigError(
        "CONFIG_IO_ERROR",
        `Failed to restore configuration profile after index write failure: ${path}`,
        { cause: rollbackError },
      );
    }
    throw indexError;
  }
  this.#index = nextIndex;
  return structuredClone(profile);
}
```

Task 5 will place these complete operations inside the write queue; this task
first verifies the single-operation lifecycle independently.

- [ ] **Step 5: Implement default selection and deletion**

Implement:

```ts
getDefaultProfileId(): string {
  return this.#index.defaultProfileId;
}

async setDefaultProfile(profileId: string): Promise<void> {
  this.#requireMetadata(profileId);
  const nextIndex: UserConfigIndex = {
    ...structuredClone(this.#index),
    defaultProfileId: profileId,
  };
  await this.#writeIndex(nextIndex);
  this.#index = nextIndex;
}

async deleteProfile(profileId: string): Promise<void> {
  this.#requireMetadata(profileId);
  if (profileId === this.#index.defaultProfileId) {
    throw new ConfigError(
      "CONFIG_DEFAULT_PROFILE_PROTECTED",
      `The default configuration profile cannot be deleted: ${profileId}`,
    );
  }
  if (Object.values(this.#index.sessionBindings).includes(profileId)) {
    throw new ConfigError(
      "CONFIG_PROFILE_IN_USE",
      `Configuration profile is selected by a session: ${profileId}`,
    );
  }
  const nextIndex: UserConfigIndex = {
    ...structuredClone(this.#index),
    profiles: this.#index.profiles
      .filter(({ id }) => id !== profileId)
      .map((metadata) => structuredClone(metadata)),
  };
  await this.#writeIndex(nextIndex);
  this.#index = nextIndex;
  await removeSensitiveFile(this.#profilePath(profileId));
}
```

Deletion commits the index first so the index never references a missing file.
If unlink fails, return `CONFIG_IO_ERROR`; the resulting orphan remains
sensitive but is not reachable from the index.

- [ ] **Step 6: Export the manager and run focused verification**

Add to `packages/config/src/index.ts`:

```ts
export { FileUserConfigManager } from "./manager.js";
export type { FileUserConfigManagerOptions } from "./manager.js";
```

Run:

```bash
pnpm vitest run packages/config/src/model.test.ts packages/config/src/manager.test.ts
pnpm --filter @kaguya/config typecheck
pnpm lint
git diff --check
```

Expected: model and profile lifecycle tests pass; typecheck, lint, and diff
check exit 0.

Commit:

```bash
git add packages/config/src/manager.ts packages/config/src/manager.test.ts packages/config/src/index.ts
git commit -m "feat(config): manage configuration profile lifecycle"
```

---

### Task 5: Session Resolution, Mutation Serialization, and Corruption Safety

**Files:**

- Modify: `packages/config/src/manager.ts`
- Modify: `packages/config/src/manager.test.ts`

**Interfaces:**

- Consumes: profile lifecycle API from Task 4.
- Produces:
  `bindSession(sessionId, profileId)`,
  `unbindSession(sessionId)`,
  `resolveProfile(sessionId)`, and a failure-safe mutation queue.

- [ ] **Step 1: Add failing session and concurrency tests**

Append to `packages/config/src/manager.test.ts`:

```ts
describe("FileUserConfigManager session selection", () => {
  it("falls back to default and resolves explicit session bindings", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const work = await manager.createProfile("work");

    await expect(manager.resolveProfile("session-1")).resolves.toMatchObject({
      id: manager.getDefaultProfileId(),
    });
    await manager.bindSession("session-1", work.id);
    await expect(manager.resolveProfile("session-1")).resolves.toMatchObject({
      id: work.id,
    });
    await manager.unbindSession("session-1");
    await expect(manager.resolveProfile("session-1")).resolves.toMatchObject({
      id: manager.getDefaultProfileId(),
    });
  });

  it("supports prototype-like session IDs without corrupting bindings", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profile = await manager.createProfile("safe");

    await manager.bindSession("__proto__", profile.id);
    await expect(manager.resolveProfile("__proto__")).resolves.toMatchObject({
      id: profile.id,
    });
    expect(Object.prototype).not.toHaveProperty("id");
  });

  it("rejects deleting a profile used by a session", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profile = await manager.createProfile("bound");
    await manager.bindSession("session-1", profile.id);

    await expect(manager.deleteProfile(profile.id)).rejects.toMatchObject({
      code: "CONFIG_PROFILE_IN_USE",
    });
  });

  it("serializes competing profile names and remains usable after failure", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });

    const results = await Promise.allSettled([
      manager.createProfile("shared"),
      manager.createProfile("shared"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await expect(manager.createProfile("after-failure")).resolves.toMatchObject(
      {
        name: "after-failure",
      },
    );
  });
});
```

- [ ] **Step 2: Run the new tests to verify RED**

Run:

```bash
pnpm vitest run packages/config/src/manager.test.ts
```

Expected: FAIL because session methods and the queue implementation are absent.

- [ ] **Step 3: Implement the failure-safe write queue**

Add to `FileUserConfigManager`:

```ts
#writeTail: Promise<void> = Promise.resolve();

#enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = this.#writeTail.then(operation, operation);
  this.#writeTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async #afterPendingWrites(): Promise<void> {
  await this.#writeTail;
}
```

Rename the four existing implementation methods to `#createProfile`,
`#updateProfile`, `#setDefaultProfile`, and `#deleteProfile` without changing
their parameters, return types, or bodies. Then add these public queueing
methods:

```ts
async createProfile(
  name: string,
  initial?: UserConfigProfileSettings,
): Promise<UserConfigProfile> {
  return this.#enqueue(() =>
    this.#createProfile(
      name,
      initial ?? emptyUserConfigProfileSettings(),
    ),
  );
}

async updateProfile(
  profileId: string,
  update: UpdateUserConfigProfileInput,
): Promise<UserConfigProfile> {
  return this.#enqueue(() => this.#updateProfile(profileId, update));
}

async setDefaultProfile(profileId: string): Promise<void> {
  return this.#enqueue(() => this.#setDefaultProfile(profileId));
}

async deleteProfile(profileId: string): Promise<void> {
  return this.#enqueue(() => this.#deleteProfile(profileId));
}
```

Name conflict, existence, default, and in-use checks stay in the extracted
private bodies, so they execute after earlier mutations. Add
`await this.#afterPendingWrites()` at the beginning of `getProfile`.
Synchronous metadata methods read the last fully committed in-memory index.

- [ ] **Step 4: Implement safe binding and resolution**

Validate session IDs without changing their exact value:

```ts
function requireSessionId(sessionId: string): string {
  if (sessionId.trim().length === 0) {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Session ID must not be empty",
    );
  }
  return sessionId;
}
```

Create binding maps with a null prototype so `__proto__`, `constructor`, and
similar IDs are ordinary own keys:

```ts
function copyBindings(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  const target = Object.create(null) as Record<string, string>;
  for (const [sessionId, profileId] of Object.entries(source)) {
    target[sessionId] = profileId;
  }
  return target;
}
```

Implement:

```ts
async bindSession(sessionId: string, profileId: string): Promise<void> {
  const requiredSessionId = requireSessionId(sessionId);
  return this.#enqueue(async () => {
    this.#requireMetadata(profileId);
    const bindings = copyBindings(this.#index.sessionBindings);
    bindings[requiredSessionId] = profileId;
    const nextIndex: UserConfigIndex = {
      ...structuredClone(this.#index),
      sessionBindings: bindings,
    };
    await this.#writeIndex(nextIndex);
    this.#index = nextIndex;
  });
}

async unbindSession(sessionId: string): Promise<void> {
  const requiredSessionId = requireSessionId(sessionId);
  return this.#enqueue(async () => {
    const bindings = copyBindings(this.#index.sessionBindings);
    if (!Object.hasOwn(bindings, requiredSessionId)) {
      return;
    }
    delete bindings[requiredSessionId];
    const nextIndex: UserConfigIndex = {
      ...structuredClone(this.#index),
      sessionBindings: bindings,
    };
    await this.#writeIndex(nextIndex);
    this.#index = nextIndex;
  });
}

async resolveProfile(sessionId: string): Promise<UserConfigProfile> {
  const requiredSessionId = requireSessionId(sessionId);
  await this.#afterPendingWrites();
  const profileId = Object.hasOwn(
    this.#index.sessionBindings,
    requiredSessionId,
  )
    ? this.#index.sessionBindings[requiredSessionId]!
    : this.#index.defaultProfileId;
  return structuredClone(await this.#readProfile(profileId));
}
```

- [ ] **Step 5: Add failing corruption and no-secret error tests**

Append:

```ts
describe("FileUserConfigManager corruption safety", () => {
  it("fails closed when index JSON is corrupt", async () => {
    const rootDir = await createRoot();
    await FileUserConfigManager.open({ rootDir });
    await writeFile(join(rootDir, "index.json"), "{not-json", "utf8");

    await expect(FileUserConfigManager.open({ rootDir })).rejects.toMatchObject(
      {
        code: "CONFIG_CORRUPT_STORE",
      },
    );
  });

  it("rejects a malformed referenced profile without exposing its secret", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const profileId = manager.getDefaultProfileId();
    const secret = "corrupt-profile-secret";
    await writeFile(
      join(rootDir, "profiles", `profile_${profileId}.json`),
      JSON.stringify({
        version: 1,
        id: profileId,
        name: "default",
        ai: { providers: [] },
        platforms: [],
        plugins: [{ id: "", enabled: true, settings: { token: secret } }],
      }),
      "utf8",
    );

    const error = await FileUserConfigManager.open({ rootDir }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "CONFIG_CORRUPT_STORE" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  });

  it("does not expose rejected secrets in validation errors", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const secret = "never-include-this-secret";
    const error = await manager
      .createProfile("invalid", {
        ai: {
          defaultProviderId: "missing",
          providers: [],
        },
        platforms: [],
        plugins: [{ id: "", enabled: true, settings: { token: secret } }],
      })
      .catch((caught: unknown) => caught);

    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
    expect(error).toMatchObject({ code: "CONFIG_INVALID_INPUT" });
  });
});
```

- [ ] **Step 6: Run focused and package verification**

Run:

```bash
pnpm vitest run packages/config/src
pnpm --filter @kaguya/config typecheck
pnpm lint
git diff --check
```

Expected: all configuration package tests pass, including concurrent duplicate
creation, queue recovery, corrupt-store failure, and secret-free errors.

Commit:

```bash
git add packages/config/src/manager.ts packages/config/src/manager.test.ts
git commit -m "feat(config): resolve profiles per session"
```

---

### Task 6: Sensitive-Configuration Documentation and Repository Integration

**Files:**

- Create: `packages/config/README.md`
- Modify: `.gitignore`
- Modify: `CONTRIBUTING.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**

- Consumes: the public API and limitations implemented in Tasks 1–5.
- Produces: contributor guidance, package discovery, architecture truth, and
  explicit leak-response instructions.

- [ ] **Step 1: Add package usage documentation**

Create `packages/config/README.md` with:

````md
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
````

- [ ] **Step 2: Add contributor and ignore rules**

Append this explicit entry to `.gitignore`:

```gitignore
/.kaguya-config/
```

Add a `## 敏感配置文件` section to `CONTRIBUTING.md` that states:

```md
本地示例统一使用 `.data/kaguya-config`，生产环境应使用仓库外、仅运行账号可访问的绝对路径。配置目录、`index.json` 和全部 profile JSON 都是敏感文件，因为其中的 API key、平台凭据和插件密钥以明文保存。

在 POSIX 系统中目录必须为 `0700`、文件必须为 `0600`。Windows 部署必须由管理员设置只允许运行身份访问的 NTFS ACL。当前实现不提供跨进程锁，同一配置根目录只能有一个写进程。

禁止把真实配置复制进测试、日志、Issue、PR 或聊天记录。测试只使用 `test-only-placeholder` 一类无效值。如果密钥进入 Git，先撤销或轮换密钥，再评估访问记录并按需清理仓库历史；仅添加 `.gitignore` 或删除最新版本不能使已泄漏密钥恢复安全。

备份、压缩包和故障现场副本仍然是敏感数据，必须限制访问并加密保存。
```

Keep the existing general `.data/` ignore. The explicit new rule covers users
who choose the documented alternate root at repository top level.

- [ ] **Step 3: Update README and architecture**

In root `README.md`:

- add “多份敏感用户配置、会话选择与默认回退” to the implemented feature list;
- add `packages/config/` to the repository tree;
- add the package README and configuration design document to the document
  links;
- remove “真实模型配置” from the list of wholly absent infrastructure and
  instead state that provider execution wiring and configuration UI remain
  outside the current scope.

In `docs/architecture.md`:

- add a table row describing `@kaguya/config` as plaintext JSON profile
  persistence, metadata-only listing, session selection, and default fallback;
- add a standalone `Config` node to the Mermaid package diagram without an
  edge to `database`;
- add a `## 用户配置边界` section documenting the file layout, public manager
  operations, sensitive directory behavior, one-writer limitation, and the
  fact that no application consumes the profiles yet.

The architecture wording must distinguish implemented storage from future UI,
provider adapter, and platform/plugin wiring.

- [ ] **Step 4: Run documentation and full repository verification**

Run:

```bash
pnpm format
pnpm format:check
pnpm lint
pnpm test
pnpm prompt:test
pnpm build
pnpm typecheck
git diff --check
git status --short
```

Expected:

- formatting, lint, Vitest, Promptfoo, build, and typecheck exit 0;
- no test creates network traffic or uses a real credential;
- `git status --short` shows only the intended Task 6 files plus generated
  tracked build outputs if this repository intentionally tracks them;
- the pre-existing untracked `docs/SDK.md` remains untracked and unstaged;
- `git diff --check` reports no whitespace errors.

Inspect staged content before committing:

```bash
git diff -- .gitignore CONTRIBUTING.md README.md docs/architecture.md packages/config/README.md
git status --short
```

Commit only source and documentation changes. Do not add `docs/SDK.md`,
temporary configuration directories, or secret-bearing JSON:

```bash
git add .gitignore CONTRIBUTING.md README.md docs/architecture.md packages/config/README.md
git commit -m "docs: document sensitive configuration handling"
```

---

## Final Verification

After all six task commits, run fresh verification from the repository root:

```bash
pnpm format:check
pnpm lint
pnpm test
pnpm prompt:test
pnpm build
pnpm typecheck
git diff --check
git status --short --branch
git log -6 --oneline
```

Acceptance evidence must show:

- every configuration test is green;
- the complete existing repository suite is green;
- package build and strict typecheck are green;
- configuration files use UUID filenames and persist plaintext test secrets;
- index and profile permissions are `0600`, directories are `0700` on POSIX;
- symlink and path-escape tests reject unsafe paths;
- failed pre-rename writes preserve the previous destination;
- profile lists and errors do not expose secret payloads;
- session bindings select an explicit profile and otherwise use the default;
- concurrent mutations in one manager instance serialize and the queue survives
  a rejected operation;
- docs state the plaintext threat model, Windows ACL requirement, one-writer
  limit, backup sensitivity, and rotate-first leak response;
- `docs/SDK.md` is still outside the commits.
