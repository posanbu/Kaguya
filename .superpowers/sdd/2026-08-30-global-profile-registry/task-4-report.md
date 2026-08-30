# Task 4 Report: Registry-backed Configuration Management

## RED evidence

Command:

```bash
pnpm vitest run apps/server/src/setup.test.ts
```

Exit status: `1`

Key failure:

```text
TypeError: createConfigurationManagement is not a function
```

The new management-facade tests failed immediately because the old one-shot
`createConfigurationSetup()` API was still the only exported setup entry point.

## GREEN evidence

Commands:

```bash
pnpm vitest run apps/server/src/setup.test.ts
pnpm --filter @kaguya/server typecheck
pnpm vitest run apps/server/src/setup.test.ts apps/server/src/server-composition.test.ts
```

All exited `0`.

Exact passing summaries:

```text
pnpm vitest run apps/server/src/setup.test.ts
Test Files  1 passed (1)
Tests  4 passed (4)

pnpm vitest run apps/server/src/setup.test.ts apps/server/src/server-composition.test.ts
Test Files  2 passed (2)
Tests  12 passed (12)
```

`pnpm --filter @kaguya/server typecheck` completed successfully after updating
the Server package to consume the new setup-management surface.

## Changes made

- Replaced the old sync `createConfigurationSetup()` facade with async
  `createConfigurationManagement()` in `apps/server/src/setup.ts`.
- Added `ConfigurationManagement`, `ProfileRegistryMetadata`, and
  `ProfileMutationResult` so create/replace/select/delete stay explicit and
  independently testable.
- Kept restart tracking process-local: `inspect()` now returns
  `restart_required` only when the selected profile on disk is ready but the
  current process has stale selected-profile state.
- Preserved selected-profile readiness visibility: if a pending-restart process
  rewrites the selected profile into `invalid` or `review_required`, `inspect()`
  returns that persisted selected readiness instead of masking it.
- Updated server startup to bootstrap/open configuration management before
  building the runtime resolver and to keep Runtime/NapCat paused when selected
  readiness is recoverably not ready.
- Updated the temporary `/api/v1/setup` bridge and HTTP tests just enough to
  compile against `ConfigurationManagement` without implementing Task 5 profile
  routes.
- Added detailed Chinese architecture headers to every changed source/test file.

## Self-review

- `setup.ts` no longer starts or reconfigures Runtime; it only wraps registry
  lifecycle and mutation results.
- `server.ts` still throws on corrupt or unsupported configuration store errors;
  only recoverable selected-profile readiness keeps the server in setup mode.
- The new tests specifically cover:
  - bootstrap/open plus selected default invalid status;
  - create vs replace vs select restart semantics;
  - selected invalid readiness while restart is pending;
  - delete of an unselected profile without restart.
- `app.ts` remains a compatibility bridge only; it uses the new management
  surface but does not add any of the Task 5 profile HTTP routes.

## Concerns

- `apps/server/src/app.test.ts` expectations were adjusted only enough for the
  new `ConfigurationManagement` type shape to compile. Task 5 should replace
  those temporary setup-route assumptions with the planned setup-status and
  profile-route coverage.
- `pnpm` continues to emit the pre-existing Homebrew `/bin/ps` sandbox warning
  before command output, but the required verification commands still completed
  successfully.
