Status: DONE
Implementation commits: `5c1b298`, `f902149`, `7d4eb60`
Verification: `pnpm vitest run packages/logger/src/information.test.ts packages/logger/src/index.test.ts` and `pnpm --filter @kaguya/logger typecheck` passed.
Scope: Added information-atom log projection with explicit levels, 168-code-point content previews, projector error reporting, and recursive redaction of sensitive projection keys while retaining legacy logger APIs.
