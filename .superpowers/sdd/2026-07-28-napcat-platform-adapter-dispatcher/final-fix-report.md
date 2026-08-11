# NapCat Platform Adapter And Dispatcher Final Fix Report

## Status

DONE_WITH_CONCERNS

The single final-review fix wave addresses all four Important findings and all
three Minor findings. The focused regression suite, full repository test suite,
and root typecheck pass.

## Findings Addressed

### Important 1: WebSocket disconnects permanently disable the bot

- Added `NapCatConnectionSupervisor` in `apps/bot/src/server.ts`.
- The supervisor owns the active transport, action client, and adapter as one
  replaceable connection.
- Transport error or close retires the complete connection and creates a fresh
  transport/client/adapter after `reconnectMs`.
- The supervisor implements `PlatformReplySender`, so workflow sends always use
  the currently active action client.
- Shutdown clears a pending reconnect timer and prevents later reconnects.
- `WebSocketJsonTransport` now supports multiple close subscribers so both the
  action client and supervisor observe disconnects.

### Important 2: Inbound workflow failures become unhandled rejections

- `NapCatOneBotAdapter` now retains every inbound dispatch promise.
- Rejections are caught and passed to an optional `onInboundError` callback with
  only `adapterId` and `traceId`.
- `apps/bot` logs the failure with a safe serialized error and trace context.
- The callback and log path receive no inbound message body, raw event, or
  access token.

### Important 3: Shutdown does not drain in-flight dispatches

- Adapter lifecycle now has an accepting state.
- `stop()` disables frame acceptance before closing the transport.
- `stop()` awaits `Promise.allSettled` for all tracked inbound dispatches.
- The runtime awaits supervisor/adapter shutdown before closing SQLite and then
  closes the root logger.
- Reconnect retirement and process shutdown share idempotent connection
  retirement promises.

### Important 4: Failed delivery receipts are silent

- `PlatformDispatcher` now inspects the `send-reply` workflow output.
- A receipt with `ok: false` emits `platform.delivery.failed` with `traceId`,
  `adapterId`, platform, and target kind.
- The receipt error string, raw NapCat response, token, and message body are not
  logged.
- `apps/bot` now initializes and closes the shared structured logger.

### Minor 1: Narrow malformed-JSON catch

- WebSocket data is parsed inside the JSON catch.
- The registered message handler runs outside the catch, so handler exceptions
  are no longer mislabeled and swallowed as malformed JSON.

### Minor 2: `KAGUYA_NAPCAT_SELF_ID` is inert

- The configured self ID is passed to `NapCatOneBotAdapter` as
  `expectedSelfId`.
- Inbound events with a missing or different `self_id` are ignored.

### Minor 3: Segment normalization removes boundary whitespace

- Text segment values are appended without per-segment trimming.
- Final normalized text is retained exactly while `text.trim()` is used only to
  decide whether the message is blank.

## TDD Evidence

Focused regression tests were written before production changes.

Initial red run:

```text
pnpm vitest run packages/platform-adapters/src/onebot.test.ts \
  packages/platform-adapters/src/napcat.test.ts \
  apps/bot/src/server.test.ts \
  apps/bot/src/dispatcher.test.ts

FAIL: 7 failed, 14 passed, 1 unhandled rejection
```

The failures covered whitespace preservation, dispatch error reporting,
in-flight draining/frame rejection, self-ID filtering, narrow JSON handling,
reconnect supervision, and delivery failure logging. The unhandled rejection
was the existing inbound workflow failure.

First green run after implementation:

```text
PASS: 4 test files, 21 tests
```

Expanded focused verification after formatting:

```text
pnpm vitest run packages/platform-adapters/src/onebot.test.ts \
  packages/platform-adapters/src/napcat.test.ts \
  apps/bot/src/server.test.ts \
  apps/bot/src/dispatcher.test.ts \
  apps/demo/src/workflows.test.ts \
  apps/demo/src/local-ingress.test.ts

PASS: 6 test files, 41 tests
```

## Required Verification

All commands used:

```text
PATH="/Users/andrewluan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
```

Results:

```text
pnpm test
PASS: 32 test files, 336 tests

pnpm typecheck
PASS: root tsc project build and @kaguya/web no-emit typecheck

git diff --check
PASS
```

Additional focused checks:

```text
pnpm --filter @kaguya/platform-adapters typecheck
PASS

pnpm --filter @kaguya/bot typecheck
PASS

pnpm vitest run apps/demo/src/workflows.test.ts apps/demo/src/local-ingress.test.ts
PASS: 2 test files, 20 tests
```

## Files Changed

- `apps/bot/src/dispatcher.test.ts`
- `apps/bot/src/dispatcher.ts`
- `apps/bot/src/server.test.ts`
- `apps/bot/src/server.ts`
- `packages/platform-adapters/src/index.ts`
- `packages/platform-adapters/src/napcat.test.ts`
- `packages/platform-adapters/src/napcat.ts`
- `packages/platform-adapters/src/onebot.test.ts`
- `packages/platform-adapters/src/onebot.ts`
- `.superpowers/sdd/2026-07-28-napcat-platform-adapter-dispatcher/final-fix-report.md`

## Boundary And Scope Check

- `@kaguya/platform-adapters` has no workflow, database, logger, or app imports.
- OneBot/NapCat details remain outside workflow nodes.
- Session and trace ID generation is unchanged.
- No media download, reverse WebSocket, HTTP webhook, durable replay, or
  multi-adapter arbitration was added.
- Local demo ingress remains sender-optional and its focused tests pass.

## Concerns

- The bundled runtime reports Node `24.14.0` while `package.json` requests Node
  `24.18.0`. pnpm emitted the existing engine warning on every required command;
  all tests and typechecks still passed.
- Reconnect behavior is covered with deterministic fake transports and timers.
  No live NapCat service was available for an external integration run.
