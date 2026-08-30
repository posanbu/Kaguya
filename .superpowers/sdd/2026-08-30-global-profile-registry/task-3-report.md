# Task 3 Report: Remove module Profile overrides and freeze one Runtime Profile

## Scope completed

- Removed `profileId` from `packages/modules/src/llm-reply.ts` so module settings and runtime LLM selections are now tier-only.
- Updated `apps/server/src/server.ts` to open the config registry, read `getSelectedProfileId()`, resolve exactly that Profile with `resolveProfileById(profileId)`, and close over one frozen selected Profile in the runtime resolver.
- Added regression coverage in:
  - `packages/modules/src/index.test.ts`
  - `packages/runtime/src/runtime.test.ts`
  - `apps/server/src/server-composition.test.ts`
- Added/updated the required detailed Chinese architecture headers in every changed source/test file.

## TDD record

1. Wrote the module regression test first:
   - schema rejects `profileId`
   - reply instances forward only `{ modelTier }`
2. Ran `pnpm vitest run packages/modules/src/index.test.ts`
   - RED confirmed: schema still accepted `profileId`
3. Wrote server resolver regressions:
   - resolver construction still succeeds with an incomplete unselected Profile present
   - resolver stays bound to the selected Profile even if registry selection changes later
   - module boundary rejects `profileId`
   - resolver call site rejects `profileId` at compile time with `// @ts-expect-error`
4. Ran `pnpm vitest run apps/server/src/server-composition.test.ts`
   - initial RED exposed expected behavior mismatch plus a stale test import/setup issue
5. Implemented the production changes in module and server code.
6. Added the runtime integration regression for two reply instances sharing one resolver and persisting no `profileId`.
7. Ran the required focused verification command:
   - `pnpm vitest run packages/runtime/src/runtime.test.ts packages/modules/src/index.test.ts apps/server/src/server-composition.test.ts`

## Verification

- Passed: `pnpm vitest run packages/runtime/src/runtime.test.ts packages/modules/src/index.test.ts apps/server/src/server-composition.test.ts`
  - Result: 3 files passed, 20 tests passed.

## Notes from self-review

- The resolver now caches provider clients only within the single selected Profile closure, which matches the new startup-only Profile selection boundary.
- Error paths still use fixed, secret-safe messages; no provider secrets or Profile override fields are persisted.

## Concern

- Full workspace server build is still blocked by pre-existing/out-of-scope references to removed config APIs in `apps/server/src/setup.ts` and `apps/server/src/setup.test.ts` (`initialize`, `getDefaultProfileId`, `updateProfile`). The Task 3 focused tests requested in the brief pass.

## Focused review fix

- Replaced the invalid regression shape in `apps/server/src/server-composition.test.ts` that previously combined `// @ts-expect-error` with a real runtime call to `resolver({ profileId, modelTier })`.
- The test now proves the public resolver contract is tier-only with a compile-time invalid `Parameters<RuntimeModelSelectionResolver>[0]` assignment, while the runtime assertion separately exercises the resolver with a real `{ modelTier: "light" }` call.

## Focused review verification

- Passed: `pnpm vitest run apps/server/src/server-composition.test.ts`
- Checked: `pnpm --filter @kaguya/server typecheck`
  - Status: still fails for pre-existing/out-of-scope `apps/server/src/setup.ts` and `apps/server/src/setup.test.ts` references to removed config APIs, so the new compile-time assertion is present in the server test but full package typecheck is not yet globally green.
