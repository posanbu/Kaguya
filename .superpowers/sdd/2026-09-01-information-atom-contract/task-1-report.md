## Task 1 Report

Commit:

- `bc051b1ded4b40682bfeb9644055839b7ab9cd2c` (`fix(schema): tighten information atom contract`)

Changed files:

- `packages/schema/src/information.ts`
- `packages/schema/src/information.test.ts`
- `packages/schema/src/index.ts`

Checks run:

- `pnpm vitest run packages/schema/src/information.test.ts`
  - Result: failed first with the expected type/runtime red condition before the fix, then passed after implementation.
- `pnpm vitest run packages/schema/src/information.test.ts packages/schema/src/index.test.ts`
  - Result: passed, `2` files / `9` tests.
- `pnpm --filter @kaguya/schema typecheck`
  - Result: passed.

Concerns:

- `freezeInformationAtom` depends on `structuredClone`, so runtime support must remain on the Node 24 baseline used by this repo.
- `cloneJsonValue` now reconstructs ordinary plain objects while still rejecting custom prototypes, matching the review fix and the brief.
