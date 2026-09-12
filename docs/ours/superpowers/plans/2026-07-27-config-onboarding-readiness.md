# Configuration Onboarding and Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace automatic empty-default creation with an explicit,
machine-readable setup flow, and prevent incomplete or unreviewed profiles from
being selected for multi-agent runtime use.

**Architecture:** Keep structural Zod parsing in `model.ts`, add a pure
readiness evaluator in `readiness.ts`, and make `FileUserConfigManager` enforce
that evaluator at initialization and session resolution boundaries. Existing
profiles remain readable and editable as drafts, while initialization and
runtime resolution return typed, secret-free setup, incomplete, or review
errors instead of falling back.

**Tech Stack:** TypeScript 6 strict ESM, Node.js 24 `fs/promises` and `crypto`,
Zod 4.4.3, Vitest 4.1.10, pnpm 11.9.0.

## Global Constraints

- Work on the existing `main` branch; do not create a worktree.
- Implement the approved design in
  `docs/superpowers/specs/2026-07-27-config-onboarding-readiness-design.md`.
- Keep API keys and credentials as plaintext JSON fields, and continue treating
  the complete configuration root as sensitive.
- Never include API keys, credentials, provider settings, plugin settings, or
  their raw values in readiness results, error messages, causes, or serialized
  errors.
- Do not create a directory or file when inspecting a missing configuration
  store.
- Do not auto-create providers, models, platforms, plugins, URLs, credentials,
  acknowledgements, or an empty default profile.
- Require at least two distinct `providerId:modelId` targets across enabled
  providers before initialization or runtime resolution succeeds.
- Do not fall back from a selected profile to another profile, provider, or
  model.
- Allow existing incomplete profiles to open, list, and update so they can be
  repaired. `createProfile()` and `updateProfile()` may persist drafts;
  `initialize()` and `resolveProfile()` are readiness gates.
- Every full `updateProfile()` clears the profile's warning acknowledgements.
- Keep the test additions focused on the approved core contract; do not produce
  a combinatorial test matrix for fields, providers, or warning combinations.
- Preserve the existing secure-file, queue, rollback, path, and permission
  behavior.
- Run Node commands with:
  `PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH`.
- Follow RED, GREEN, REFACTOR and make one focused commit per task.

## Public Contracts

Add the following public types:

```ts
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
```

Add these manager entry points:

```ts
export interface FileUserConfigInitializeOptions {
  readonly rootDir: string;
  readonly name: string;
  readonly settings: UserConfigProfileSettings;
  readonly acknowledgedWarnings?: readonly string[];
}

static inspect(
  options: FileUserConfigManagerOptions,
): Promise<ConfigurationReadiness>;

static initialize(
  options: FileUserConfigInitializeOptions,
): Promise<FileUserConfigManager>;

inspectProfile(profileId: string): Promise<ProfileReadiness>;

acknowledgeConfigurationWarnings(
  profileId: string,
  warningIds: readonly string[],
): Promise<void>;
```

Add typed errors that retain the existing `ConfigError` base:

```ts
export class ConfigSetupRequiredError extends ConfigError {
  readonly guidance: ConfigurationGuidance;
}

export class ConfigIncompleteError extends ConfigError {
  readonly issues: readonly ConfigurationIssue[];
}

export class ConfigReviewRequiredError extends ConfigError {
  readonly warnings: readonly ConfigurationWarning[];
}
```

The subclasses use fixed messages, pass no `cause`, and copy only the
secret-free readiness objects.

---

### Task 1: Define the Readiness Model and Pure Evaluator

**Files:**

- Modify: `packages/config/src/model.ts`
- Modify: `packages/config/src/model.test.ts`
- Modify: `packages/config/src/errors.ts`
- Create: `packages/config/src/readiness.ts`
- Create: `packages/config/src/readiness.test.ts`
- Modify: `packages/config/src/index.ts`

**Interfaces:**

- Consumes: parsed `UserConfigProfile`.
- Produces: `inspectUserConfigProfile()`, an internal
  `deriveConfigurationWarnings()` helper, setup guidance, readiness types, and
  typed readiness errors.
- Does not access the filesystem or network.

- [ ] **Step 1: Write focused failing model/readiness tests**

In `model.test.ts`, replace the old expectation that a disabled
`defaultProviderId` is structurally rejected with an assertion that it parses.
This moves the provider-reference rule to runtime readiness while preserving
structural editability.

Create `readiness.test.ts` with one complete profile factory:

```ts
function profileWith(
  providers: UserConfigProfile["ai"]["providers"],
  overrides: Partial<UserConfigProfile> = {},
): UserConfigProfile {
  return userConfigProfileSchema.parse({
    version: 1,
    id: "4f649709-50d9-4fc4-8df4-95f96163f7c9",
    name: "test",
    ai: {
      defaultProviderId: providers[0]?.id,
      providers,
    },
    platforms: [
      {
        id: "platform-1",
        type: "test",
        enabled: true,
        credentials: {},
        settings: {},
      },
    ],
    plugins: [{ id: "plugin-1", enabled: true, settings: {} }],
    ...overrides,
  });
}
```

Cover only these cases:

1. one enabled provider with one model returns `invalid`;
2. two distinct models in one provider return `ready`;
3. one model in each of two enabled providers returns `ready`;
4. missing `baseUrl`, missing `apiKey`, empty `platforms`, and empty `plugins`
   produce stable warning IDs, while disabled providers do not warn;
5. a test key placed in `apiKey` and JSON settings is absent from
   `JSON.stringify(readiness)`.

Use exact issue IDs and paths:

```text
default-provider-missing                  ai.defaultProviderId
default-provider-not-enabled              ai.defaultProviderId
enabled-provider-models-empty:<provider>  ai.providers.<index>.models
duplicate-model:<provider>:<model>         ai.providers.<index>.models.<index>
insufficient-model-targets                ai.providers
```

Use exact warning IDs and paths:

```text
provider-base-url-missing:<provider>       ai.providers.<index>.baseUrl
provider-api-key-missing:<provider>        ai.providers.<index>.apiKey
platforms-empty                            platforms
plugins-empty                              plugins
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm vitest run packages/config/src/model.test.ts \
  packages/config/src/readiness.test.ts
```

Expected: FAIL because `readiness.ts`, the review schema, and readiness exports
do not exist.

- [ ] **Step 3: Add optional persisted review metadata**

In `model.ts`, define:

```ts
const userConfigProfileReviewSchema = z.strictObject({
  acknowledgedWarnings: z.array(nonEmptyIdSchema),
});
```

Add `review: userConfigProfileReviewSchema.optional()` to
`userConfigProfileInnerSchema`, not to
`userConfigProfileSettingsInnerSchema`. Reject an explicitly present
`undefined` review value with `rejectOwnUndefined()`.

Remove the `aiConfigInnerSchema` refinement that requires
`defaultProviderId` to reference an enabled provider. Keep duplicate provider,
platform, and plugin ID checks as structural validation. This ensures a legacy
or draft profile with a stale default provider can be inspected and repaired
instead of being classified as a corrupt store.

Keep `UpdateUserConfigProfileInput` equal to full settings plus optional name.
It intentionally does not accept `review`, so a normal update cannot preserve
stale acknowledgements.

- [ ] **Step 4: Add readiness error codes**

Append to `configErrorCodes`:

```ts
"CONFIG_SETUP_REQUIRED",
"CONFIG_INCOMPLETE",
"CONFIG_REVIEW_REQUIRED",
```

Keep `ConfigError` unchanged. Implement the three typed subclasses in
`readiness.ts` so their structured fields match their error code and never
retain a cause.

- [ ] **Step 5: Implement the pure evaluator**

In `readiness.ts`:

1. Export a frozen `configurationSetupGuidance` containing exactly the five
   approved steps.
2. Derive model issues in deterministic provider/model order.
3. Treat target identity as `` `${provider.id}:${modelId}` ``.
4. Check model duplicates within each enabled provider.
5. Count distinct targets across all enabled providers and require two.
6. Derive warnings only for enabled providers and only when optional properties
   are absent (`=== undefined`).
7. Expose `deriveConfigurationWarnings(profile)` from the module for manager
   validation, but do not re-export it from the package root.
8. Compute unacknowledged warnings by subtracting
   `profile.review?.acknowledgedWarnings ?? []`.
9. Return `invalid` before considering warnings, `review_required` before
   `ready`.

Do not interpolate URLs, API keys, settings, credentials, or any JSON field
value into IDs/messages. Provider and model identifiers may appear only in the
stable IDs already specified; they are routing identifiers, not secret payload
values.

- [ ] **Step 6: Export the public contracts**

Update `index.ts` to export:

- `configurationSetupGuidance`
- `inspectUserConfigProfile`
- all readiness types
- all three typed readiness errors
- `FileUserConfigInitializeOptions` once it exists in Task 2

- [ ] **Step 7: Run focused tests and typecheck to verify GREEN**

Run:

```bash
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm vitest run packages/config/src/model.test.ts \
  packages/config/src/readiness.test.ts
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm --filter @kaguya/config typecheck
```

Expected: both commands PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/config/src/model.ts packages/config/src/model.test.ts \
  packages/config/src/errors.ts packages/config/src/readiness.ts \
  packages/config/src/readiness.test.ts packages/config/src/index.ts
git commit -m "feat(config): add profile readiness evaluation"
```

---

### Task 2: Replace Automatic Store Creation with Inspect and Initialize

**Files:**

- Modify: `packages/config/src/manager.ts`
- Modify: `packages/config/src/manager.test.ts`
- Modify: `packages/config/src/index.ts`

**Interfaces:**

- Consumes: readiness evaluator and secure JSON primitives.
- Produces: side-effect-free `inspect()`, explicit `initialize()`, and
  setup-required `open()`.

- [ ] **Step 1: Write failing first-run tests**

Replace the old `"creates and reopens one default profile"` test with:

```ts
it("inspects a missing store without creating files", async () => {
  const parent = await createRoot();
  const rootDir = join(parent, "not-created");

  await expect(FileUserConfigManager.inspect({ rootDir })).resolves.toEqual({
    status: "setup_required",
    guidance: configurationSetupGuidance,
  });
  await expect(access(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(FileUserConfigManager.open({ rootDir })).rejects.toMatchObject({
    code: "CONFIG_SETUP_REQUIRED",
  });
  await expect(access(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
});
```

Add one initialization test that verifies:

- a one-model candidate rejects with `CONFIG_INCOMPLETE`;
- an unacknowledged-warning candidate rejects with
  `CONFIG_REVIEW_REQUIRED`;
- both failures leave the target directory absent;
- a complete two-model candidate initializes and reopens with its first profile
  selected as default.

Use a candidate with `baseUrl`, `apiKey`, one platform, and one plugin for the
successful path so acknowledgement mechanics remain isolated to Task 3.

- [ ] **Step 2: Run the new first-run tests to verify RED**

Run:

```bash
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm vitest run packages/config/src/manager.test.ts \
  -t "missing store|initializes"
```

Expected: FAIL because `inspect()` and `initialize()` do not exist and `open()`
still creates an empty default.

- [ ] **Step 3: Add explicit initialization options**

In `manager.ts`, export:

```ts
export interface FileUserConfigInitializeOptions extends FileUserConfigManagerOptions {
  readonly name: string;
  readonly settings: UserConfigProfileSettings;
  readonly acknowledgedWarnings?: readonly string[];
}
```

Parse `rootDir`, `name`, settings, and the acknowledgement list without
retaining hostile inputs or validation causes. Invalid structure remains
`CONFIG_INVALID_INPUT`.

- [ ] **Step 4: Make missing-store inspection side-effect free**

Implement `FileUserConfigManager.inspect()` in this order:

1. validate and resolve `rootDir`;
2. derive `indexPath` and assert it stays inside the root;
3. call `access(indexPath)` before any `ensureSensitiveDirectory()` call;
4. on `ENOENT`, return
   `{ status: "setup_required", guidance: configurationSetupGuidance }`;
5. otherwise call `open()` to apply the existing permission, symlink,
   corruption, and referenced-profile checks;
6. inspect the selected default profile and return its readiness.

Do not catch permission, unsafe path, malformed JSON, or corruption errors as
setup-required.

- [ ] **Step 5: Make `open()` report setup instead of creating defaults**

Refactor `open()` so it checks `index.json` before creating or correcting any
directory. If the index is missing, throw `ConfigSetupRequiredError`. If it
exists, preserve the current secure-directory setup, index parsing, and
referenced-profile validation.

Delete the empty-settings branch of `createInitialStore()`. `open()` must never
call an initializer.

- [ ] **Step 6: Implement zero-write validation and explicit initialization**

Implement `initialize()` in this order:

1. parse all caller input into detached safe values;
2. create an in-memory candidate profile with a generated UUID;
3. derive the candidate's current warning IDs and reject duplicate, empty, or
   unknown acknowledgement IDs with `CONFIG_INVALID_INPUT`;
4. attach the validated acknowledgement IDs;
5. inspect the candidate entirely in memory;
6. throw `ConfigIncompleteError` for `invalid`;
7. throw `ConfigReviewRequiredError` for remaining warnings;
8. only after readiness is `ready`, verify that `index.json` does not already
   exist;
9. create secure root/profile directories;
10. write the candidate profile, then the index that selects it as default;
11. if index write fails, remove the just-written profile before rethrowing;
12. return a manager backed by the newly written index.

If the store already exists, throw `CONFIG_INVALID_INPUT` with the fixed message
`"Configuration store is already initialized"`; never overwrite it.

Reuse the existing atomic sensitive-file helpers and rollback pattern. Do not
write a temporary incomplete profile merely to reuse `createProfile()`.

- [ ] **Step 7: Migrate existing tests to explicit initialized fixtures**

Inside `manager.test.ts`, add a small `initializeReadyManager(rootDir)` helper
that calls `initialize()` with:

- one enabled provider selected as default;
- two distinct model IDs;
- non-empty `baseUrl` and `apiKey`;
- one platform;
- one plugin.

Mechanically replace existing fresh-store `open({ rootDir })` setup calls with
this helper, except tests that explicitly exercise:

- missing-store `inspect()` / `open()`;
- `initialize()`;
- reopening an already initialized store;
- hand-written corrupt/unsafe filesystem fixtures.

Keep the existing lifecycle, queue, rollback, permissions, hostile-input, and
secret tests intact. Update their expected profile counts and default profile
contents only where the new explicit initial profile changes those assertions.

- [ ] **Step 8: Run manager tests and typecheck to verify GREEN**

Run:

```bash
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm vitest run packages/config/src/manager.test.ts
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm --filter @kaguya/config typecheck
```

Expected: both commands PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add packages/config/src/manager.ts packages/config/src/manager.test.ts \
  packages/config/src/index.ts
git commit -m "feat(config): require explicit store initialization"
```

---

### Task 3: Persist Warning Acknowledgements and Gate Resolution

**Files:**

- Modify: `packages/config/src/manager.ts`
- Modify: `packages/config/src/manager.test.ts`

**Interfaces:**

- Consumes: `inspectUserConfigProfile()` and typed readiness errors.
- Produces: profile inspection, warning acknowledgement, acknowledgement
  invalidation, and no-fallback runtime enforcement.

- [ ] **Step 1: Write failing acknowledgement and resolution tests**

Add only these focused tests:

1. Create a structurally valid two-model profile missing all four optional
   items. Assert `inspectProfile()` returns `review_required` with the stable
   IDs. Assert `resolveProfile()` throws `CONFIG_REVIEW_REQUIRED`. Acknowledge
   exactly those IDs and assert resolution succeeds. Run `updateProfile()` with
   the same settings and assert resolution is blocked again because review was
   cleared.
2. Create one invalid profile and one ready default profile. Bind a session to
   the invalid profile and assert `resolveProfile()` throws
   `CONFIG_INCOMPLETE`, not the default profile. Then make the invalid profile
   the default, leave another ready profile present, and assert an unbound
   session also throws `CONFIG_INCOMPLETE`.
3. Put a recognizable test key in an invalid/review profile and assert it is
   absent from both `String(error)` and `JSON.stringify(error)`.

In the acknowledgement test, also reject one stale/unknown warning ID with
`CONFIG_INVALID_INPUT` and verify the profile file is unchanged.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm vitest run packages/config/src/manager.test.ts \
  -t "acknowledges|does not fall back|readiness errors"
```

Expected: FAIL because inspection, acknowledgement, and resolution gating are
not implemented.

- [ ] **Step 3: Add profile inspection**

Implement:

```ts
async inspectProfile(profileId: string): Promise<ProfileReadiness> {
  await this.#afterPendingWrites();
  return inspectUserConfigProfile(await this.#readProfile(profileId));
}
```

Return a detached result. The evaluator already allocates new issue/warning
objects, but use `structuredClone()` at the public boundary for consistency.

- [ ] **Step 4: Add acknowledgement validation and persistence**

Implement `acknowledgeConfigurationWarnings()` through `#enqueue()`:

1. validate `warningIds` as a duplicate-free array of non-empty strings;
2. read the current profile;
3. derive all current warning IDs without applying prior acknowledgements;
4. reject any requested ID that is not currently present with
   `CONFIG_INVALID_INPUT`;
5. persist:

```ts
review: {
  acknowledgedWarnings: [...warningIds].sort(),
}
```

6. update the profile metadata timestamp;
7. use the existing profile-write/index-write/rollback ordering;
8. update the in-memory index only after both writes succeed.

Extract a private profile-replacement helper if needed so acknowledgement and
full update share the same atomic rollback path.

Acknowledging a subset is valid but leaves the remaining warnings in
`review_required`. Acknowledging an empty array clears all confirmations.

- [ ] **Step 5: Invalidate review on every full profile update**

Keep the `#updateProfile()` reconstruction limited to:

```ts
{
  version: 1,
  id: profileId,
  name,
  ...parsedUpdate.settings,
}
```

Do not copy `oldProfile.review`. Add an assertion to the Task 3 test that the
persisted profile no longer has `review` after any successful
`updateProfile()`, even when the submitted settings are value-equivalent.

- [ ] **Step 6: Gate exactly the selected profile during resolution**

After the existing binding/default selection, inspect only that profile:

```ts
const profile = await this.#readProfile(profileId);
const readiness = inspectUserConfigProfile(profile);

if (readiness.status === "invalid") {
  throw new ConfigIncompleteError(readiness.issues);
}
if (readiness.status === "review_required") {
  throw new ConfigReviewRequiredError(readiness.warnings);
}
return structuredClone(profile);
```

Do not loop over profiles and do not modify the session binding or default
profile. Preserve the initial `#afterPendingWrites()` call.

- [ ] **Step 7: Run focused and complete package tests**

Run:

```bash
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm vitest run packages/config/src/manager.test.ts
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm vitest run packages/config/src
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm --filter @kaguya/config typecheck
```

Expected: all commands PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add packages/config/src/manager.ts packages/config/src/manager.test.ts
git commit -m "feat(config): gate profile resolution on readiness"
```

---

### Task 4: Document the Explicit Setup and Review Flow

**Files:**

- Modify: `packages/config/README.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/pull-request-user-config.md`
- Modify: `CONTRIBUTING.md`

**Interfaces:**

- Documents: first-run inspection, explicit initialization, readiness errors,
  multi-model requirement, warning acknowledgement, and no-fallback behavior.

- [ ] **Step 1: Update the package example**

Replace the current `open()`-first example in `packages/config/README.md` with:

```ts
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

Add a compact initialization example with two models, and explain that a caller
must surface `CONFIG_REVIEW_REQUIRED` warnings and retry initialization or call
`acknowledgeConfigurationWarnings()` only after explicit user confirmation.

- [ ] **Step 2: Correct fallback language across project docs**

Update all affected docs so they state:

- session binding/default profile selects one candidate only;
- the selected candidate must be ready;
- no missing-store empty profile is generated;
- no incomplete selected profile falls back to another profile;
- at least two distinct model targets are required;
- provider execution failures are returned directly by the future execution
  layer.

Keep secret-handling and filesystem-security guidance unchanged.

- [ ] **Step 3: Add contributor verification guidance**

In `CONTRIBUTING.md`, add the focused config commands:

```bash
pnpm vitest run packages/config/src
pnpm --filter @kaguya/config typecheck
```

State that tests must use placeholders, must never read real local
configuration roots, and must verify readiness/error output contains no
plaintext credential values.

- [ ] **Step 4: Run documentation and repository verification**

Run:

```bash
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm exec prettier --check packages/config/README.md README.md \
  docs/architecture.md docs/pull-request-user-config.md CONTRIBUTING.md \
  docs/superpowers/specs/2026-07-27-config-onboarding-readiness-design.md \
  docs/superpowers/plans/2026-07-27-config-onboarding-readiness.md
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH pnpm test
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH pnpm typecheck
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH pnpm lint
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH pnpm build
PATH=/Users/andrewluan/.nvm/versions/node/v24.18.0/bin:$PATH pnpm format:check
git diff --check
```

Expected: all commands PASS. If a pre-existing unrelated failure appears,
record the exact command/output and verify all config-specific commands still
pass before proceeding.

- [ ] **Step 5: Review the final diff for secret and fallback regressions**

Run:

```bash
git diff -- packages/config README.md CONTRIBUTING.md docs/architecture.md \
  docs/pull-request-user-config.md
rg -n "fallback|fall back|default profile|CONFIG_(SETUP_REQUIRED|INCOMPLETE|REVIEW_REQUIRED)" \
  packages/config README.md CONTRIBUTING.md docs
rg -n "apiKey|credentials" packages/config/src/readiness.ts \
  packages/config/src/manager.ts packages/config/src/readiness.test.ts \
  packages/config/src/manager.test.ts
```

Confirm:

- no readiness message interpolates a secret-bearing field;
- missing-store inspection performs no write or directory creation;
- initialization validates readiness before its first filesystem mutation;
- runtime resolution evaluates exactly one selected profile;
- tests contain placeholders only;
- docs contain no claim of automatic empty-default creation or runtime
  fallback.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/config/README.md README.md CONTRIBUTING.md \
  docs/architecture.md docs/pull-request-user-config.md
git commit -m "docs: explain explicit configuration readiness"
```

---

## Completion Criteria

- A missing configuration store yields fixed setup guidance and no filesystem
  side effects.
- `open()` never creates a default profile and throws
  `CONFIG_SETUP_REQUIRED` when the store is absent.
- `initialize()` writes only after a two-model candidate is valid and every
  current optional warning has been explicitly acknowledged.
- Existing incomplete profiles can still be opened and edited.
- A selected incomplete or unreviewed profile blocks resolution with a typed,
  secret-free error.
- Explicit bindings and default selection never fall back to another profile.
- Warning acknowledgements persist per profile and every full update clears
  them.
- The reduced core readiness tests, existing package tests, repository
  typecheck, lint, build, and formatting checks pass.
- Documentation matches the implemented setup, review, and no-fallback
  behavior.
