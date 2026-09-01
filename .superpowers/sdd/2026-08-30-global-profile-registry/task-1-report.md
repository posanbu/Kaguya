# Task 1 Report

Status: complete.

Implemented the v3 registry schema foundation for `packages/config`, including:

- reserved `ProfileId` support for `"default"` plus UUIDs,
- v3 `userConfigIndexSchema` with `selectedProfileId`,
- default-profile invariants and unique ID/name checks,
- `ReplaceUserConfigProfileInput`,
- safe registry readiness composition via `withRegistryReadiness`,
- updated package exports,
- and Chinese architecture headers on all touched source and test files.

Verification:

- `pnpm vitest run packages/config/src/model.test.ts`
- `pnpm vitest run packages/config/src/readiness.test.ts`
- `pnpm vitest run packages/config/src/model.test.ts packages/config/src/readiness.test.ts`

All passed.

Fix round:

- Narrowed the public readiness contract so `ConfigurationReadiness` continues
  to expose the registry-bearing existing-store result while remaining
  compatible with current profile-only call sites.
- Deep-detached registry metadata in `withRegistryReadiness` so later caller
  mutation cannot alter the readiness snapshot.

Verification:

- `pnpm vitest run packages/config/src/model.test.ts packages/config/src/readiness.test.ts`

`pnpm exec tsc -p packages/config/tsconfig.json --noEmit` still reports
pre-existing Task 2 `manager.ts` errors on `version: 2` / `defaultProfileId`
references, which were intentionally left untouched per the review note.
