# Task 8 Report

## Scope

Task 8 performed the final stale-contract scan for the Global Profile Registry
work and updated the remaining current documentation to match the v3 contract:

- `selectedProfileId` is the only runtime Profile selector.
- modules choose only `modelTier`, never `profileId`.
- `bootstrap()` is the explicit first-write operation for an empty config root.
- `resolveProfileById(profileId)` always requires an explicit ID.
- switching or replacing the selected Profile requires a restart before Runtime
  picks up the frozen startup configuration.

The task also tightened one remaining UI-side fallback by reading the selected
Profile from registry metadata directly, then added a small unit test around the
registry metadata helper.

## Notable follow-up during verification

`pnpm format:check` initially failed on a large existing set of tracked files
plus SDD workspace artifacts. To satisfy the acceptance gate, a repository-wide
Prettier normalization was applied to the flagged set. That formatter pass
surfaced one real regression in
`apps/server/src/server-composition.test.ts`: a `@ts-expect-error` directive was
left on the declaration line while TypeScript now reported the error on the
formatted `profileId` property line. The fix moved the directive onto the
property itself. No production behavior changed in that follow-up.

## Verification

Final verification was run on the final tree on 2026-08-30:

- `pnpm build` -> passed
- `pnpm lint` -> passed
- `pnpm typecheck` -> passed
- `pnpm test` -> passed (`36` test files, `377` tests)
- `pnpm format:check` -> passed
- `git diff --check` -> passed

## Result

The branch now reflects the v3 Global Profile Registry contract in the current
runtime/UI docs, the remaining UI helper no longer layers extra selected-Profile
fallback behavior on top of the explicit registry contract, and the required
verification gate is green.

## Review follow-up

A later review identified four still-live surfaced docs that had retained older
default-profile and `POST /api/v1/setup` wording:

- `docs/en/manual/configuration/index.md`
- `docs/zh/manual/configuration/index.md`
- `docs/en/develop/message-server-and-adapters.md`
- `docs/zh/develop/message-server-and-adapters.md`

Those pages now describe the v3 selected-profile contract instead: setup status
comes from `GET /api/v1/setup`, mutations go through the explicit
`/api/v1/profiles*` routes, the empty reserved `default` Profile is created by
bootstrap, and any change that affects the selected Profile requires a restart
before Runtime picks it up.

A follow-up wording fix tightened the restart description further: the UI does
not prompt for restart after every save or selection. It stays in
`invalid`/`review_required` guidance while the selected Profile is not ready,
and only surfaces `restart_required` after a ready selected Profile differs
from the Runtime snapshot frozen at startup.

The final contract correction fixed one deeper server/UI mismatch that review
found after the docs rounds. `GET /api/v1/setup` had been returning only
`{ status: "restart_required" }`, which forced the Web UI to synthesize
registry metadata locally. The implementation now keeps safe
`selectedProfileId` and `profiles` metadata on `restart_required`, the Web API
client requires that shape, and the UI consumes the server metadata directly
instead of fabricating a fallback registry. The live English
`docs/en/manual/configuration/bot-config.md` page was also updated from the old
v2/default/initialize/optional-resolve wording to the v3
selected-profile/bootstrap/explicit-ID contract.

Focused verification for this correction on 2026-08-30:

- `pnpm vitest run apps/server/src/setup.test.ts apps/server/src/app.test.ts apps/web/src/api.test.ts apps/web/src/App.test.ts` -> passed (`4` files, `63` tests)
- `pnpm --filter @kaguya/server typecheck` -> passed
- `pnpm --filter @kaguya/web typecheck` -> passed
- `pnpm format:check` -> passed
- `git diff --check` -> passed

One more server-contract review round corrected the generated OpenAPI and the
runtime-only `/api/v1/setup` fallback. The response schema now explicitly
requires `status`, `selectedProfileId`, and `profiles`, and the route returns
that full safe shape even when `createHttpApplication()` is used without a
`ConfigurationManagement` instance. `/api/v1/setup` is now present in OpenAPI,
and both the route contract tests and the server composition tests assert the
required metadata shape.

Focused verification for this final correction on 2026-08-30:

- `pnpm vitest run apps/server/src/setup.test.ts apps/server/src/app.test.ts apps/server/src/server-composition.test.ts apps/web/src/api.test.ts apps/web/src/App.test.ts` -> passed (`5` files, `73` tests)
- `pnpm --filter @kaguya/server typecheck` -> passed
- `pnpm --filter @kaguya/web typecheck` -> passed
- `pnpm format:check` -> passed
- `git diff --check` -> passed

The final documentation sweep fixed two remaining live-doc defects: the
`packages/config/README.md` example now uses the actual `createProfile(name:
string)` API shape, and the current README/WebUI/architecture pages now describe
the v3 `selectedProfileId` registry plus the conditional `restart_required`
behavior instead of older unconditional "save then restart" wording.

Focused doc verification on 2026-08-30:

- targeted `rg` stale-contract scan across `packages/config/README.md`,
  `README.md`, `docs/en/manual/webui/index.md`,
  `docs/zh/manual/webui/index.md`, `docs/en/develop/index.md`, and
  `docs/zh/develop/index.md` -> no matches for the reviewed stale patterns
- `pnpm format:check` -> passed
- `git diff --check` -> passed

The final review round on 2026-08-30 addressed two remaining contract gaps.
First, `apps/server/src/app.ts` now validates profile selection requests with
the same `profileIdSchema` used by the config layer and emits stricter OpenAPI
JSON schemas for profile metadata, setup status, and full profile replacement
payloads. The generated contract now marks required nested fields and disallows
unexpected properties where the HTTP surface already treats the shapes as
closed.

Second, the still-live `docs/*/develop/webui-api/{index,system-control}.md`
pages were not describing Kaguya at all; they were old MaiBot/FastAPI docs.
Those pages now explicitly mark themselves as legacy-reference notes and
redirect readers to the current `/api/v1/*` gateway, including the
`selectedProfileId` registry model and the conditional `restart_required`
behavior.

To avoid a lingering type-contract mismatch, `apps/web/src/api.ts` now documents
why the client still accepts `setup_required`: the lower config library can emit
it before bootstrap, while the normal Kaguya server startup path typically
bootstraps the empty registry first and therefore exposes `invalid`,
`review_required`, `restart_required`, or `ready` on `/api/v1/setup`.

Focused verification for this round on 2026-08-30:

- `pnpm vitest run apps/server/src/app.test.ts apps/server/src/server-composition.test.ts apps/server/src/setup.test.ts apps/web/src/api.test.ts apps/web/src/App.test.ts` -> passed (`5` files, `73` tests)
- `pnpm --filter @kaguya/server typecheck` -> passed
- `pnpm --filter @kaguya/web typecheck` -> passed
- `pnpm format:check` -> passed
- targeted `rg` scan of the touched `docs/*/develop/webui-api/*` pages ->
  matched only the intentional legacy-reference notices for old MaiBot routes
- `git diff --check` -> passed
