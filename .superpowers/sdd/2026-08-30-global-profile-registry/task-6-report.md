# Task 6 Report

## RED

Initial focused test run:

```bash
pnpm vitest run apps/web/src/api.test.ts apps/web/src/profile-editor.test.ts
```

Observed failures:

- `listProfiles`, `createProfile`, `getProfile`, `replaceProfile`, `selectProfile`, and `deleteProfile` were missing from `apps/web/src/api.ts`.
- `apps/web/src/profile-editor.ts` did not exist.
- The new API tests failed with `TypeError: ... is not a function`.

## GREEN

Final focused test run:

```bash
pnpm vitest run apps/web/src/api.test.ts apps/web/src/profile-editor.test.ts
```

Result: 23 tests passed.

Typecheck:

```bash
pnpm --filter @kaguya/web typecheck
```

Result: passed.

## FIX ROUND 1

Changed:

- `initializeConfiguration` now replaces `/api/v1/profiles/default` directly when `profileName === "default"`, while named profiles still create first and then replace the created ID.
- `mergeProfileEditorFields` now preserves unrelated acknowledged warnings and only toggles the known optional warning IDs.
- `getConfigurationStatus`, `listProfiles`, `createProfile`, `getProfile`, `replaceProfile`, `selectProfile`, and `deleteProfile` now reject malformed response shapes instead of accepting empty shells.

Regression tests added:

- Default-profile compatibility wrapper behavior.
- Warning preservation and optional-warning toggling.
- Malformed setup metadata and malformed profile response rejection.

Fix verification:

```bash
pnpm vitest run apps/web/src/api.test.ts apps/web/src/profile-editor.test.ts
pnpm --filter @kaguya/web typecheck
```

Result: both passed.

## FIX ROUND 2

Changed:

- `mergeProfileEditorFields` now keeps only acknowledgements that remain valid after the edited profile is rebuilt, so stale provider warnings fall away while still-valid hidden warnings remain.
- `apps/web/src/api.ts` now validates nested provider, platform, plugin, model tier, settings, and credentials shapes so malformed nested response shells such as `providers: [null]` are rejected.

Regression tests added:

- Base URL edits remove `provider-base-url-missing:*` while preserving still-valid optional warnings.
- Clearing the optional checkbox removes only the optional warnings and retains still-valid hidden provider warnings.
- Nested malformed profile responses are rejected.

Fix verification:

```bash
pnpm vitest run apps/web/src/api.test.ts apps/web/src/profile-editor.test.ts
pnpm --filter @kaguya/web typecheck
```

Result: both passed.

## SHA

`d531ada`

## Concerns

- `initializeConfiguration` remains as a compatibility wrapper in `apps/web/src/api.ts` so the current `App.tsx` setup flow still compiles. The new profile registry helpers are the intended path; Task 7 should remove the legacy setup UI dependency.
