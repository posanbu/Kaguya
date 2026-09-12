# Global Profile Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace implicit Profile defaults and module overrides with a v3
Registry containing a reserved empty `default` Profile and one explicitly
selected global Profile.

**Architecture:** `@kaguya/config` owns the v3 schema, explicit bootstrap, and
Profile lifecycle. The Server bootstraps only an empty root, freezes the selected
Profile into one Runtime resolver, and exposes authenticated management routes.
The WebUI manages Profiles through separate create, replace, and select actions
while merging visible edits into the complete loaded Profile.

**Tech Stack:** TypeScript 6, Node.js 24 filesystem APIs, Zod, Fastify, React 19,
Vitest, pnpm workspaces.

**Spec:**
`docs/ours/superpowers/specs/2026-08-30-global-profile-registry-design.md`

## Global Constraints

- The index format is version 3; versions 1 and 2 are rejected without any file
  modification or migration.
- `default` is both the reserved Profile ID and name. It always exists and
  cannot be renamed or deleted.
- User Profiles use UUIDs and unique, trimmed, non-empty names.
- `selectedProfileId` is explicit, references a Registry member, and has no
  fallback semantics.
- `inspect()` is read-only. Only explicit `bootstrap()` creates the empty v3
  Registry.
- Only the selected Profile controls Runtime readiness. Runtime configuration is
  frozen until restart.
- Profile bodies and secrets require management authentication; anonymous setup
  state exposes metadata and readiness only.
- Create, replace, and select remain separate operations.
- Every changed source or test file must maintain the required detailed Chinese
  architecture header comment; documentation and machine-readable files do not
  receive source headers.
- Every production behavior starts with a failing test that is observed failing
  for the intended reason.
- Preserve existing sensitive permissions, atomic writes, symlink rejection,
  path containment, mutation serialization, and secret-safe errors.

## File map

**Configuration model and storage**

- `packages/config/src/model.ts` — v3 Profile ID and Registry schemas plus full
  replacement types.
- `packages/config/src/errors.ts` — stable unsupported-version error code.
- `packages/config/src/readiness.ts` — safe Registry-level readiness result.
- `packages/config/src/manager.ts` — explicit bootstrap and Profile lifecycle.
- `packages/config/src/index.ts` — public exports.
- `packages/config/src/model.test.ts` — v3 schema contract.
- `packages/config/src/manager.test.ts` — filesystem and lifecycle contract.
- `packages/config/src/readiness.test.ts` — selected-Profile readiness payload.

**Runtime and modules**

- `packages/modules/src/llm-reply.ts` — tier-only module selection.
- `packages/modules/src/index.test.ts` — module settings reject Profile overrides.
- `packages/runtime/src/runtime.ts` — consumes the tier-only selection type.
- `packages/runtime/src/runtime.test.ts` — shared resolver behavior.

**Server and HTTP API**

- `apps/server/src/setup.ts` — replace one-shot initialization with Registry
  management and restart tracking.
- `apps/server/src/setup.test.ts` — safe status and independent mutations.
- `apps/server/src/server.ts` — bootstrap and freeze the selected Profile only.
- `apps/server/src/server-composition.test.ts` — startup and resolver contract.
- `apps/server/src/app.ts` — authenticated Profile routes and error mapping.
- `apps/server/src/app.test.ts` — management API, auth, and OpenAPI behavior.

**Web client**

- `apps/web/src/api.ts` — typed Profile management requests.
- `apps/web/src/api.test.ts` — request and response contracts.
- `apps/web/src/profile-editor.ts` — pure full-Profile-to-form and merge helpers.
- `apps/web/src/profile-editor.test.ts` — hidden-field preservation and blank
  Profile behavior.
- `apps/web/src/App.tsx` — Profile list, editor, explicit actions, and restart UI.
- `apps/web/src/styles.css` — responsive Profile management layout.

**Documentation**

- `packages/config/README.md` — v3 Registry and manager API.
- `README.md` — startup and global Profile summary if its current configuration
  section references the old flow.

## Task 1: Define the v3 Registry schema and safe readiness type

**Files:**

- Modify: `packages/config/src/model.test.ts`
- Modify: `packages/config/src/model.ts`
- Modify: `packages/config/src/errors.ts`
- Modify: `packages/config/src/readiness.test.ts`
- Modify: `packages/config/src/readiness.ts`
- Modify: `packages/config/src/index.ts`

**Interfaces:**

- Produces: `ProfileId`, `profileIdSchema`, `ReplaceUserConfigProfileInput`,
  `UserConfigIndex`, and `ConfigurationReadiness` carrying metadata and
  `selectedProfileId` for existing stores.
- Consumes: existing Profile settings, metadata, issue, and warning schemas.

- [ ] **Step 1: Add the required Chinese architecture headers to every touched
      source and test file in this task.**

  The `model.ts` header must describe schema ownership, JSON cloning, v3
  referential invariants, and its manager/API consumers. Test headers must name
  the production contract they protect rather than describe Vitest mechanics.

- [ ] **Step 2: Write failing v3 schema tests.**

  Add focused cases equivalent to:

  ```ts
  expect(profileIdSchema.parse("default")).toBe("default");
  expect(profileIdSchema.safeParse("named-profile").success).toBe(false);

  expect(
    userConfigIndexSchema.parse({
      version: 3,
      selectedProfileId: "default",
      profiles: [defaultMetadata],
    }),
  ).toMatchObject({ version: 3, selectedProfileId: "default" });

  expect(
    userConfigIndexSchema.safeParse({
      version: 3,
      selectedProfileId: userProfileId,
      profiles: [defaultMetadata],
    }).success,
  ).toBe(false);
  ```

  Add separate failures for a missing `default`, a default metadata name other
  than `default`, duplicate IDs, duplicate names, `defaultProfileId`, and index
  versions 1 and 2.

- [ ] **Step 3: Run the model tests and verify RED.**

  Run:

  ```bash
  pnpm vitest run packages/config/src/model.test.ts
  ```

  Expected: failures show that `default` is not accepted and v3 index documents
  are rejected by the current v2 schema.

- [ ] **Step 4: Implement the minimal v3 schemas and replacement type.**

  Introduce the exact logical definitions:

  ```ts
  const userProfileIdSchema = z.uuid();
  const profileIdInnerSchema = z.union([
    z.literal("default"),
    userProfileIdSchema,
  ]);

  export type ProfileId = z.infer<typeof profileIdSchema>;

  export type ReplaceUserConfigProfileInput = UserConfigProfileSettings & {
    readonly name: string;
    readonly acknowledgedWarnings: readonly string[];
  };
  ```

  Change the index to `version: z.literal(3)` and
  `selectedProfileId: profileIdSchema`. Its refinement must count exactly one
  `default`, enforce its name, preserve unique IDs/names, and enforce selected
  referential integrity. Add a Profile refinement enforcing
  `id === "default" => name === "default"`.

- [ ] **Step 5: Write failing Registry readiness tests.**

  Define the desired existing-store result:

  ```ts
  expect(status).toEqual({
    status: "invalid",
    selectedProfileId: "default",
    profiles: [defaultMetadata],
    issues: expect.arrayContaining([
      expect.objectContaining({ id: "default-provider-missing" }),
    ]),
  });
  ```

  Confirm `JSON.stringify(status)` excludes a fixture API key and provider
  settings.

- [ ] **Step 6: Run readiness tests and verify RED.**

  Run:

  ```bash
  pnpm vitest run packages/config/src/readiness.test.ts
  ```

  Expected: `ConfigurationReadiness` and its producer do not yet carry Registry
  metadata or selection.

- [ ] **Step 7: Implement safe Registry readiness composition and exports.**

  Keep `ProfileReadiness` unchanged and add a detached composition helper:

  ```ts
  export type ExistingConfigurationReadiness = ProfileReadiness & {
    readonly profiles: readonly UserConfigProfileMetadata[];
    readonly selectedProfileId: ProfileId;
  };

  export function withRegistryReadiness(
    profiles: readonly UserConfigProfileMetadata[],
    selectedProfileId: ProfileId,
    readiness: ProfileReadiness,
  ): ExistingConfigurationReadiness;
  ```

  `ConfigurationReadiness` remains the union of `setup_required` and the new
  existing-store result. Add `CONFIG_UNSUPPORTED_VERSION` to
  `configErrorCodes`, and export all new public types/functions from `index.ts`.

- [ ] **Step 8: Run Task 1 tests and verify GREEN.**

  Run:

  ```bash
  pnpm vitest run packages/config/src/model.test.ts packages/config/src/readiness.test.ts
  ```

  Expected: both files pass with no warnings.

- [ ] **Step 9: Commit Task 1.**

  ```bash
  git add packages/config/src/model.ts packages/config/src/model.test.ts packages/config/src/errors.ts packages/config/src/readiness.ts packages/config/src/readiness.test.ts packages/config/src/index.ts
  git commit -m "feat(config): define profile registry v3"
  ```

## Task 2: Implement explicit bootstrap and Profile lifecycle

**Files:**

- Modify: `packages/config/src/manager.test.ts`
- Modify: `packages/config/src/manager.ts`
- Modify: `packages/config/src/index.ts`

**Interfaces:**

- Consumes: Task 1 `ProfileId`, `ReplaceUserConfigProfileInput`, v3 schemas, and
  safe readiness composition.
- Produces: `FileUserConfigManager.bootstrap`, `getSelectedProfileId`,
  `replaceProfile`, `selectProfile`, and mandatory-ID `resolveProfileById`.

- [ ] **Step 1: Update source and test header comments for the new manager
      contract.**

  The manager header must document index-last bootstrap publication, rollback,
  serialized mutations, exact-ID lookup, selected deletion protection, and
  legacy rejection.

- [ ] **Step 2: Replace initialization tests with failing bootstrap tests.**

  Cover an absent root and an existing empty directory. After bootstrap assert:

  ```ts
  expect(await readJson(join(root, "index.json"))).toEqual({
    version: 3,
    selectedProfileId: "default",
    profiles: [expect.objectContaining({ id: "default", name: "default" })],
  });
  expect(await readJson(join(root, "profiles/profile_default.json"))).toEqual({
    version: 1,
    id: "default",
    name: "default",
    ai: { providers: [] },
    platforms: [],
    plugins: [],
  });
  ```

  Assert `inspect()` before bootstrap returns `setup_required` without creating
  paths, and after bootstrap returns selected `invalid` metadata without secrets.
  Add refusal cases for a stray file, orphaned `profiles/`, and an existing
  index.

- [ ] **Step 3: Run bootstrap tests and verify RED.**

  Run the new tests by name:

  ```bash
  pnpm vitest run packages/config/src/manager.test.ts -t "bootstrap"
  ```

  Expected: `bootstrap` is undefined and the old initializer creates a UUID
  Profile instead of reserved `default`.

- [ ] **Step 4: Implement explicit bootstrap and read-only inspection.**

  Remove `FileUserConfigInitializeOptions`, `initialize()`, and its parsers.
  Before creating directories, use `lstat`/`readdir` to accept only an absent or
  empty root. Construct:

  ```ts
  const profile: UserConfigProfile = {
    version: 1,
    id: "default",
    name: "default",
    ...emptyUserConfigProfileSettings(),
  };
  const index: UserConfigIndex = {
    version: 3,
    selectedProfileId: "default",
    profiles: [{ id: "default", name: "default", createdAt, updatedAt }],
  };
  ```

  Write the Profile first, publish the index last, and remove only the Profile
  created by this attempt if index publication fails. Do not remove a root the
  caller already owned.

- [ ] **Step 5: Write failing lifecycle and explicit-ID tests.**

  Replace old default tests with cases proving:

  ```ts
  const created = await manager.createProfile("work");
  expect(created.id).toMatch(UUID_PATTERN);
  expect(manager.getSelectedProfileId()).toBe("default");
  expect(created.ai.providers).toEqual([]);

  await manager.selectProfile(created.id);
  expect(manager.getSelectedProfileId()).toBe(created.id);

  await expect(manager.deleteProfile(created.id)).rejects.toMatchObject({
    code: "CONFIG_PROFILE_IN_USE",
  });
  await expect(manager.deleteProfile("default")).rejects.toMatchObject({
    code: "CONFIG_DEFAULT_PROFILE_PROTECTED",
  });
  ```

  Add tests that `getProfile`, `replaceProfile`, `selectProfile`, `deleteProfile`,
  and `resolveProfileById` reject unknown valid UUIDs. Use
  `manager.resolveProfileById(undefined as never)` to prove the runtime boundary
  rejects omitted IDs.

- [ ] **Step 6: Run lifecycle tests and verify RED.**

  ```bash
  pnpm vitest run packages/config/src/manager.test.ts -t "profile lifecycle|profile resolution"
  ```

  Expected: old default naming and optional resolution behavior fail.

- [ ] **Step 7: Implement the explicit lifecycle.**

  Rename methods and fields consistently:

  ```ts
  getSelectedProfileId(): ProfileId;
  replaceProfile(
    profileId: ProfileId,
    replacement: ReplaceUserConfigProfileInput,
  ): Promise<UserConfigProfile>;
  selectProfile(profileId: ProfileId): Promise<void>;
  resolveProfileById(profileId: ProfileId): Promise<UserConfigProfile>;
  ```

  `createProfile(name)` always uses empty settings. `replaceProfile` validates
  the complete replacement and current warning acknowledgements before writing;
  it fixes `default` to its reserved name. `selectProfile` only changes the
  index. `deleteProfile` rejects `default` and `selectedProfileId`.

- [ ] **Step 8: Write failing legacy and rollback tests.**

  For fixture indexes with `version: 1` and `version: 2`, capture
  `readFile(indexPath)` before `inspect()`, `open()`, and `bootstrap()`; assert
  each rejects with `CONFIG_UNSUPPORTED_VERSION` and the bytes remain equal.
  Preserve existing create/update/delete rollback tests under renamed methods.

- [ ] **Step 9: Run legacy and rollback tests and verify RED.**

  ```bash
  pnpm vitest run packages/config/src/manager.test.ts -t "unsupported|rollback|index write"
  ```

  Expected: v2 currently parses and the new unsupported-version error is absent.

- [ ] **Step 10: Implement explicit legacy detection and finish manager
      cleanup.**

  Inspect only the untrusted top-level `version` without invoking getters or
  retaining values. Throw:

  ```ts
  new ConfigError(
    "CONFIG_UNSUPPORTED_VERSION",
    "Configuration index version 1 or 2 is unsupported; back up the configuration and reinitialize it.",
  );
  ```

  Do this before any directory preparation or write. Remove obsolete default and
  initialize names from production exports.

- [ ] **Step 11: Run all config tests and verify GREEN.**

  ```bash
  pnpm vitest run packages/config/src
  ```

  Expected: all config tests pass; no old initialization/default fallback tests
  remain.

- [ ] **Step 12: Commit Task 2.**

  ```bash
  git add packages/config/src
  git commit -m "feat(config): add explicit profile registry lifecycle"
  ```

## Task 3: Remove module Profile overrides and freeze one Runtime Profile

**Files:**

- Modify: `packages/modules/src/index.test.ts`
- Modify: `packages/modules/src/llm-reply.ts`
- Modify: `packages/runtime/src/runtime.test.ts`
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `apps/server/src/server-composition.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Consumes: Task 2 `getSelectedProfileId()` and mandatory
  `resolveProfileById(profileId)`.
- Produces: tier-only `ModuleModelSelection` and a Server resolver closed over
  one selected `UserConfigProfile`.

- [ ] **Step 1: Update architecture headers in all touched Runtime, module, and
      Server files.**

  Explicitly state that Profile selection belongs to Server startup and cannot
  be overridden by module settings or messages.

- [ ] **Step 2: Write failing module tests for tier-only selection.**

  Replace the old independent Profile test with:

  ```ts
  expect(
    llmReplySettingsSchema.safeParse({
      profileId: crypto.randomUUID(),
      modelTier: "light",
      outbound: { mode: "source", messageKind: "text" },
    }).success,
  ).toBe(false);

  expect(selections).toEqual([{ modelTier: "light" }, { modelTier: "heavy" }]);
  ```

- [ ] **Step 3: Run module tests and verify RED.**

  ```bash
  pnpm vitest run packages/modules/src/index.test.ts
  ```

  Expected: `profileId` is still accepted and forwarded.

- [ ] **Step 4: Remove `profileId` from module selection and settings.**

  Make `ModuleModelSelection` exactly:

  ```ts
  export interface ModuleModelSelection {
    readonly modelTier: ModelTier;
  }
  ```

  Remove `profileId` from `llmReplySettingsSchema` and construct
  `selection: { modelTier: settings.modelTier }` unconditionally.

- [ ] **Step 5: Write failing Server resolver tests.**

  Bootstrap a Registry, fully replace and acknowledge `default`, create an
  incomplete unselected Profile, then assert resolver construction succeeds.
  Create a ready second Profile, select it, construct the resolver, mutate the
  Registry selection afterward, and assert both tier calls still use the second
  Profile's models. Assert the resolver rejects an object containing
  `profileId` at compile time with `// @ts-expect-error` and at the module schema
  boundary.

- [ ] **Step 6: Run Server composition tests and verify RED.**

  ```bash
  pnpm vitest run apps/server/src/server-composition.test.ts
  ```

  Expected: the current resolver loads all Profiles and accepts per-call
  overrides.

- [ ] **Step 7: Freeze only the selected Profile in Server composition.**

  Implement this shape:

  ```ts
  const manager = await FileUserConfigManager.open({ rootDir: configRoot });
  const selectedProfileId = manager.getSelectedProfileId();
  const profile = await manager.resolveProfileById(selectedProfileId);

  const resolver: RuntimeModelSelectionResolver = ({ modelTier }) => {
    const target = profile.ai.modelTiers?.[modelTier];
    // Resolve only within `profile`; throw directly for every missing edge.
  };
  ```

  Remove the all-Profile map and Profile-aware cache key. Validate light and
  heavy tiers before returning the resolver.

- [ ] **Step 8: Add and run a Runtime shared-resolver test.**

  Activate two LLM reply instances with different tiers, dispatch through the
  real Runtime, and assert one injected resolver receives exactly
  `{ modelTier: "light" }` and `{ modelTier: "heavy" }`, with no Profile key in
  persisted messages.

  ```bash
  pnpm vitest run packages/runtime/src/runtime.test.ts packages/modules/src/index.test.ts apps/server/src/server-composition.test.ts
  ```

  Expected: all three files pass.

- [ ] **Step 9: Commit Task 3.**

  ```bash
  git add packages/modules/src packages/runtime/src/runtime.ts packages/runtime/src/runtime.test.ts apps/server/src/server.ts apps/server/src/server-composition.test.ts
  git commit -m "refactor(runtime): use one selected profile"
  ```

## Task 4: Replace one-shot setup with Registry management

**Files:**

- Modify: `apps/server/src/setup.test.ts`
- Modify: `apps/server/src/setup.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Consumes: Task 2 manager lifecycle and Task 1 readiness result.
- Produces: `ConfigurationManagement` used by HTTP routes and startup.

- [ ] **Step 1: Update source and test headers to describe the management
      facade and restart-state boundary.**

- [ ] **Step 2: Write failing management-facade tests.**

  Replace initial-provider submission tests with:

  ```ts
  const management = await createConfigurationManagement(root);
  expect(await management.inspect()).toMatchObject({
    status: "invalid",
    selectedProfileId: "default",
    profiles: [expect.objectContaining({ id: "default" })],
  });

  const created = await management.createProfile("work");
  expect(created.profile.id).toMatch(UUID_PATTERN);
  expect(created.restartRequired).toBe(false);
  expect((await management.inspect()).selectedProfileId).toBe("default");
  ```

  Add separate replace and select calls. Replacing an unselected Profile reports
  `restartRequired: false`; selecting it reports `true`; replacing the selected
  Profile reports `true`. The selected ready state becomes
  `restart_required`, while selected incomplete state remains `invalid` or
  `review_required` with restart pending internally.

- [ ] **Step 3: Run setup tests and verify RED.**

  ```bash
  pnpm vitest run apps/server/src/setup.test.ts
  ```

  Expected: only `initialize()` exists and it combines multiple actions.

- [ ] **Step 4: Implement `ConfigurationManagement`.**

  Replace the interface with:

  ```ts
  export interface ConfigurationManagement {
    inspect(): Promise<ConfigurationSetupStatus>;
    listProfiles(): Promise<ProfileRegistryMetadata>;
    getProfile(profileId: string): Promise<UserConfigProfile>;
    createProfile(name: string): Promise<ProfileMutationResult>;
    replaceProfile(
      profileId: string,
      replacement: ReplaceUserConfigProfileInput,
    ): Promise<ProfileMutationResult>;
    selectProfile(profileId: string): Promise<ProfileMutationResult>;
    deleteProfile(profileId: string): Promise<ProfileMutationResult>;
  }
  ```

  Make `createConfigurationManagement(rootDir)` async. It calls
  `FileUserConfigManager.inspect`; on `setup_required` it calls explicit
  `bootstrap`, otherwise it opens the Registry. Keep only process-local
  `restartRequired`; no method starts or reconfigures Runtime.

- [ ] **Step 5: Wire async management creation into Server startup.**

  Construct management before attempting the Runtime resolver. Pass it to the
  HTTP application in both setup and ready modes. Preserve corrupt/unsupported
  failure behavior and pause Runtime/NapCat for recoverable selected readiness.

- [ ] **Step 6: Run setup and Server composition tests and verify GREEN.**

  ```bash
  pnpm vitest run apps/server/src/setup.test.ts apps/server/src/server-composition.test.ts
  ```

- [ ] **Step 7: Commit Task 4.**

  ```bash
  git add apps/server/src/setup.ts apps/server/src/setup.test.ts apps/server/src/server.ts apps/server/src/server-composition.test.ts
  git commit -m "feat(server): manage explicit profile registry"
  ```

## Task 5: Add authenticated Profile HTTP APIs

**Files:**

- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**

- Consumes: Task 4 `ConfigurationManagement`.
- Produces: the six `/api/v1/profiles` capabilities and expanded anonymous setup
  status.

- [ ] **Step 1: Update `app.ts` and `app.test.ts` headers with route ownership,
      authentication ordering, and error mapping.**

- [ ] **Step 2: Write failing anonymous-status and route-authentication tests.**

  Assert anonymous setup returns metadata/readiness but no fixture secret. For
  every management method, send a request without Authorization and assert 401
  before malformed path/body validation. Include `GET /profiles` in this matrix.

- [ ] **Step 3: Run the new API tests and verify RED.**

  ```bash
  pnpm vitest run apps/server/src/app.test.ts -t "profile|setup status|authenticates profile"
  ```

  Expected: Profile routes return 404 and setup lacks Registry metadata.

- [ ] **Step 4: Define strict Zod and OpenAPI schemas.**

  Add bodies:

  ```ts
  const createProfileRequestSchema = z
    .object({
      name: z.string().trim().min(1).max(100),
    })
    .strict();

  const selectionRequestSchema = z
    .object({
      selectedProfileId: profileIdSchema,
    })
    .strict();

  const replaceProfileRequestSchema = z
    .object({
      name: z.string().trim().min(1).max(100),
      ai: aiConfigSchema,
      platforms: z.array(platformConfigSchema),
      plugins: z.array(pluginConfigSchema),
      acknowledgedWarnings: z.array(z.string().trim().min(1)),
    })
    .strict();
  ```

  Export schema inputs from `@kaguya/config` rather than duplicating secret
  settings validation. Add PUT and DELETE to CORS methods.

- [ ] **Step 5: Write failing CRUD, selection, and HTTP mapping tests.**

  Exercise the real management facade where practical. Prove create does not
  select; get returns the requested Profile; replace preserves the submitted
  full body; selection is explicit; allowed deletion returns 204. Cover invalid
  ID 400, unknown UUID 404, duplicate/protected/in-use 409, and remove
  `POST /api/v1/setup` with a 404 assertion.

- [ ] **Step 6: Run CRUD tests and verify RED.**

  ```bash
  pnpm vitest run apps/server/src/app.test.ts -t "creates profile|reads profile|replaces profile|selects profile|deletes profile|maps profile"
  ```

- [ ] **Step 7: Implement routes and centralized ConfigError mapping.**

  Reuse one `requireManagementToken` hook. Register literal
  `/api/v1/profiles/selection` before `/:profileId`. Map:

  ```ts
  CONFIG_INVALID_INPUT -> 400 profile_invalid
  CONFIG_PROFILE_NOT_FOUND -> 404 profile_not_found
  CONFIG_PROFILE_NAME_CONFLICT -> 409 profile_name_conflict
  CONFIG_DEFAULT_PROFILE_PROTECTED -> 409 profile_protected
  CONFIG_PROFILE_IN_USE -> 409 profile_in_use
  ```

  Keep infrastructure errors out of client responses and logs free of request
  bodies.

- [ ] **Step 8: Run all Server API tests and verify GREEN.**

  ```bash
  pnpm vitest run apps/server/src/app.test.ts
  ```

- [ ] **Step 9: Commit Task 5.**

  ```bash
  git add apps/server/src/app.ts apps/server/src/app.test.ts
  git commit -m "feat(server): expose profile management api"
  ```

## Task 6: Build typed Web API and full-Profile merge helpers

**Files:**

- Modify: `apps/web/src/api.test.ts`
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/profile-editor.test.ts`
- Create: `apps/web/src/profile-editor.ts`

**Interfaces:**

- Consumes: Task 5 HTTP shapes.
- Produces: Web request functions, `ProfileEditorFields`,
  `profileToEditorFields`, and `mergeProfileEditorFields` for `App.tsx`.

- [ ] **Step 1: Add detailed Chinese headers to both API files and both editor
      helper files.**

  The helper header must explain that it is the client-side preservation
  boundary for undisplayed settings and secrets.

- [ ] **Step 2: Write failing Web API request tests.**

  Add tests for:

  ```ts
  await listProfiles({ token }, request);
  await createProfile({ token }, { name: "work" }, request);
  await getProfile({ token }, profileId, request);
  await replaceProfile({ token }, profileId, replacement, request);
  await selectProfile({ token }, profileId, request);
  await deleteProfile({ token }, profileId, request);
  ```

  Assert exact method, encoded URL, Bearer header, content type, and JSON body.
  Assert each rejects locally when token is blank. Replace the old setup POST
  test with the expanded anonymous setup response.

- [ ] **Step 3: Run Web API tests and verify RED.**

  ```bash
  pnpm vitest run apps/web/src/api.test.ts
  ```

  Expected: none of the new functions or response guards exist.

- [ ] **Step 4: Implement strict typed Web API functions.**

  Add client types mirroring only the necessary wire contract. Encode IDs with
  `encodeURIComponent`. Centralize authenticated JSON requests without storing
  Profile API keys in browser storage. Remove `InitialConfigurationInput` and
  `initializeConfiguration`.

- [ ] **Step 5: Write failing Profile merge tests.**

  Use a complete Profile fixture with two providers, non-empty platforms,
  plugins, credentials, and nested provider settings. Change displayed URL,
  models, API key, name, and acknowledgement. Assert the result changes only the
  intended provider/tier/name/review fields and preserves every hidden fixture
  value by literal equality.

  Add an empty `default` case that creates one `default-provider` entry and two
  distinct tier targets without fabricating platforms or plugins.

- [ ] **Step 6: Run helper tests and verify RED.**

  ```bash
  pnpm vitest run apps/web/src/profile-editor.test.ts
  ```

- [ ] **Step 7: Implement pure editor conversion and merge functions.**

  Use this public shape:

  ```ts
  export interface ProfileEditorFields {
    readonly name: string;
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly lightModel: string;
    readonly heavyModel: string;
    readonly acknowledgeOptional: boolean;
  }

  export function profileToEditorFields(
    profile: UserConfigProfile,
  ): ProfileEditorFields;

  export function mergeProfileEditorFields(
    profile: UserConfigProfile,
    fields: ProfileEditorFields,
  ): ReplaceProfileInput;
  ```

  Clone arrays/objects before modification. Reuse an existing selected
  OpenAI-compatible provider where possible; otherwise append
  `default-provider`. Preserve that provider's `settings`, all other providers,
  platforms, and plugins.

- [ ] **Step 8: Run Task 6 tests and verify GREEN.**

  ```bash
  pnpm vitest run apps/web/src/api.test.ts apps/web/src/profile-editor.test.ts
  ```

- [ ] **Step 9: Commit Task 6.**

  ```bash
  git add apps/web/src/api.ts apps/web/src/api.test.ts apps/web/src/profile-editor.ts apps/web/src/profile-editor.test.ts
  git commit -m "feat(web): add profile management client"
  ```

## Task 7: Replace the one-shot setup form with Profile management UI

**Files:**

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- Consumes: Task 6 API and editor helper functions.
- Produces: the setup/management workflow visible in WebUI.

- [ ] **Step 1: Update the App source header and add a CSS file header.**

  The App header must describe view states, token handling, Profile loading,
  independent mutations, and Runtime restart behavior. The CSS header must name
  the Profile list/editor layout and responsive boundary.

- [ ] **Step 2: Add a failing compile check by switching App imports and state to
      the new API.**

  Replace the old initialization import with the new list/get/create/replace/
  select/delete functions and `profile-editor` helpers, without implementing the
  components yet.

  Run:

  ```bash
  pnpm --filter @kaguya/web typecheck
  ```

  Expected: missing Profile management components/state references fail type
  checking. This is the RED boundary for UI composition; behavior logic is
  already protected by Task 6 unit tests.

- [ ] **Step 3: Implement the Profile management state machine.**

  Keep these explicit states:

  ```ts
  type ConfigurationView =
    "checking" | "profiles" | "restart" | "chat" | "error";
  ```

  Anonymous setup status supplies initial metadata and selected ID. Enter
  `profiles` automatically for invalid/review-required state and expose a
  Settings button from ready chat. Token entry precedes secret Profile loading.
  Track `openedProfileId`, loaded complete Profile, editor fields, mutation
  status, and restart relevance separately.

- [ ] **Step 4: Implement independent Profile actions.**

  Provide separate controls and handlers:

- Create prompts for or reveals a name field, calls only `createProfile`,
  refreshes metadata, and opens the new Profile without selecting it.
- Save calls `mergeProfileEditorFields` and `replaceProfile` for the loaded ID.
- Select calls only `selectProfile` and refreshes setup status.
- Delete is disabled for `default` and selected Profile and calls only
  `deleteProfile` otherwise.

  Lock the default name input, disable save until an authenticated full Profile
  is loaded, and clear secret-bearing state when switching Profiles or leaving
  the management screen.

- [ ] **Step 5: Implement restart and readiness presentation.**

  Display selected readiness issues/warnings without secret values. Show the
  restart screen only when the selected Profile is ready and a selected
  replacement or selection changed the frozen Runtime configuration. Keep
  Runtime paused and the editor visible for invalid/review-required selected
  Profiles.

- [ ] **Step 6: Add responsive styles.**

  Use a two-column `.profile-workspace` with a bounded metadata sidebar and a
  flexible editor card. Collapse it to one column under 800px. Reuse existing
  colors, spacing, buttons, fields, focus styles, and reduced-motion behavior;
  do not introduce a new visual system.

- [ ] **Step 7: Run Web tests, typecheck, and build.**

  ```bash
  pnpm vitest run apps/web/src
  pnpm --filter @kaguya/web typecheck
  pnpm --filter @kaguya/web build
  ```

  Expected: API/helper tests pass and the React application typechecks/builds.

- [ ] **Step 8: Commit Task 7.**

  ```bash
  git add apps/web/src/App.tsx apps/web/src/styles.css
  git commit -m "feat(web): add explicit profile management"
  ```

## Task 8: Update current documentation and verify the repository

**Files:**

- Modify: `packages/config/README.md`
- Modify: `README.md` only if its current configuration section describes the
  removed initialization/default behavior.
- Modify: any current non-historical source or documentation file found by the
  stale-contract scan.

**Interfaces:**

- Consumes: all completed tasks.
- Produces: current public documentation and final acceptance evidence.

- [ ] **Step 1: Scan for stale live contracts.**

  Run:

  ```bash
  rg -n --glob '!dist/**' --glob '!docs/ours/superpowers/specs/**' --glob '!docs/ours/superpowers/plans/**' 'defaultProfileId|getDefaultProfileId|setDefaultProfile|initializeConfiguration|FileUserConfigManager\.initialize|profileId.*modelTier|POST /api/v1/setup' README.md packages apps docs
  ```

  Classify every match. Historical design/plan records remain historical;
  executable code, tests, package README files, and current user/developer docs
  must use the v3 contract.

- [ ] **Step 2: Update current documentation.**

  Explain reserved empty `default`, explicit bootstrap, v3 rejection policy,
  separate Profile management actions, global selection, authenticated secret
  reads, and restart-to-apply behavior. Do not document fallback or migration.

- [ ] **Step 3: Run focused acceptance tests.**

  ```bash
  pnpm vitest run packages/config/src packages/modules/src apps/server/src apps/web/src packages/runtime/src/runtime.test.ts
  ```

  Expected: all focused tests pass with zero failures.

- [ ] **Step 4: Run the complete verification suite.**

  Run each command separately and inspect its full output:

  ```bash
  pnpm build
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm format:check
  git diff --check
  ```

  Expected: every command exits 0; Vitest reports zero failed tests; Prettier
  reports all matched files formatted.

- [ ] **Step 5: Perform the acceptance checklist.**

  Verify against real tests and files:

- Fresh root contains only empty `default` plus v3 Registry and enters setup.
- `default` cannot be renamed or deleted.
- Create does not select.
- Selection rejects unknown IDs and does not fall back.
- Only selected readiness controls Runtime startup.
- Module settings reject `profileId`.
- Full replacement preserves WebUI-hidden settings through the merge helper.
- Selection and selected replacement require restart.
- v1/v2 inputs remain byte-for-byte unchanged after rejection.
- Anonymous responses contain no Profile secret.

- [ ] **Step 6: Commit documentation and any final verified cleanup.**

  ```bash
  git add README.md packages/config/README.md packages apps
  git commit -m "docs: document global profile registry"
  ```

  If `README.md` was not changed, omit it from `git add`. Do not commit build
  outputs or unrelated user files.
