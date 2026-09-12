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

## Fix round

### RED evidence

Command:

```bash
pnpm vitest run apps/server/src/app.test.ts apps/server/src/server-composition.test.ts
```

Exit status: `1`

Key failures:

```text
apps/server/src/app.test.ts > maps a setup readiness race to configuration_not_required
expected 400 to be 409

apps/server/src/server-composition.test.ts > keeps unrecoverable management creation on the startup fatal-and-close path
expected "closeLogger" to be called with arguments ... Number of calls: 0
```

The first regression showed that the temporary `/api/v1/setup` bridge still
collapsed a second-readiness-check race into `configuration_invalid`/400. The
second showed that unrecoverable management creation happened before the guarded
startup path, so the structured `server.start.failed` + logger close sequence
was skipped.

### GREEN evidence

Commands:

```bash
pnpm vitest run apps/server/src/setup.test.ts apps/server/src/app.test.ts apps/server/src/server-composition.test.ts
pnpm --filter @kaguya/server typecheck
```

All exited `0`.

Exact passing summary:

```text
pnpm vitest run apps/server/src/setup.test.ts apps/server/src/app.test.ts apps/server/src/server-composition.test.ts
Test Files  3 passed (3)
Tests  33 passed (33)
```

`pnpm --filter @kaguya/server typecheck` completed successfully after the fix
round changes.

### Fixes applied

- Moved `createConfigurationManagement()` under the startup `try` in
  `apps/server/src/server.ts`, made shutdown tolerate a not-yet-created
  `runtime`, and preserved the existing fatal log plus logger-close path for
  unrecoverable config-store failures during bootstrap/open.
- Added a focused startup regression in
  `apps/server/src/server-composition.test.ts` that asserts
  `CONFIG_UNSUPPORTED_VERSION` still triggers `server.start.failed`,
  `server.stopping`, `server.stopped`, and `closeLogger(...)`.
- Added `ConfigurationSetupNotRequiredError` in `apps/server/src/setup.ts` so
  the temporary setup bridge can distinguish the second-readiness-check race
  from normal invalid input.
- Updated `apps/server/src/app.ts` to map that race-specific error to HTTP 409
  `configuration_not_required`, and added the changing-`inspect()` regression in
  `apps/server/src/app.test.ts`.
