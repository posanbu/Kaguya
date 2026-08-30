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

## SHA

`83f92ec`

## Concerns

- `initializeConfiguration` remains as a compatibility wrapper in `apps/web/src/api.ts` so the current `App.tsx` setup flow still compiles. The new profile registry helpers are the intended path; Task 7 should remove the legacy setup UI dependency.
