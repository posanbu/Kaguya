# Task 2 Report: NapCat Action Client And Adapter Transport

## Result

Implemented the injected JSON transport boundary for NapCat in
`@kaguya/platform-adapters`.

## Changes

- Added `JsonMessageTransport` with JSON send, message, close, and shutdown
  operations.
- Added `NapCatActionClient implements PlatformReplySender`.
- Private replies use `send_private_msg`; group replies use
  `send_group_msg`, through `buildOneBotSendAction`.
- Matching echo responses resolve successful receipts with normalized message
  IDs, or failed receipts using NapCat wording/message fallbacks.
- Pending actions time out with `NapCat action timed out` and resolve as failed
  receipts.
- Transport close resolves all pending actions with the close error or
  `NapCat connection closed`.
- Added `NapCatOneBotAdapter` lifecycle methods. It ignores echo responses,
  normalizes inbound message events, dispatches them to the injected callback,
  and closes the injected transport on stop.
- Exported the new client, adapter, transport, and option types from
  `src/index.ts`.

The implementation contains no workflow, database, application, WebSocket,
HTTP webhook, media download, durable queue, or arbitration behavior.

## TDD Evidence

1. Action-client tests were written first. The first run failed because
   `./napcat.js` did not exist.
2. The action-client implementation was added. The focused run passed with 2
   tests.
3. The adapter inbound test was added before restoring the adapter
   implementation. The next run failed with `NapCatOneBotAdapter is not a
   constructor` while the two action tests remained green.
4. The adapter implementation was restored. The focused NapCat run passed with
   3 tests.

## Verification

- `pnpm vitest run packages/platform-adapters/src/onebot.test.ts packages/platform-adapters/src/napcat.test.ts`
  passed: 2 files, 8 tests.
- `pnpm --filter @kaguya/platform-adapters typecheck` passed.
- `pnpm test` passed: 28 files, 319 tests.
- `pnpm typecheck` passed.
- `git diff --check` passed.

All commands used the bundled Node runtime path. pnpm reported the existing
engine warning because the runtime is Node `24.14.0` while the repository
declares `24.18.0`; it did not affect the passing checks.

## Commit

- `bb25af358dda2d736d532941420bb443700e450f` - `feat: add napcat action client`

## Fix Round 1

### Review Findings Addressed

- Added a per-transport JSON message fan-out router in `napcat.ts`. The
  action client and inbound adapter now subscribe through one underlying
  transport listener, so the design remains correct even when an injected
  transport stores only one callback.
- Added a same-transport integration test that constructs both components and
  verifies inbound dispatch and matching action-reply resolution.
- Added focused timeout coverage asserting the exact failed receipt error.
- Added focused transport-close coverage asserting pending actions resolve
  with `NapCat connection closed`.

### TDD Evidence

- Initial fix-round test run, before the routing change, failed in the shared
  transport integration test because the receipt resolved as failed after the
  adapter overwrote the action listener.
- The same run also exposed that the test transport contract is `close():
  void`; the close test was corrected to assert the specified default close
  error rather than passing an unsupported error argument.
- After the router and test-fake correction, the focused NapCat run passed with
  6 tests.
- A subsequent package typecheck caught and then resolved a strict TypeScript
  closure-narrowing issue in the fan-out callback.

### Commands And Output

```text
PATH="/Users/andrewluan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm vitest run packages/platform-adapters/src/napcat.test.ts
PASS: 1 test file, 6 tests

PATH="/Users/andrewluan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm --filter @kaguya/platform-adapters typecheck
PASS: tsc -b --pretty false

PATH="/Users/andrewluan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm test
PASS: 28 test files, 322 tests

PATH="/Users/andrewluan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm typecheck
PASS: root tsc and @kaguya/web typecheck
```

The commands emitted the existing pnpm engine warning because the available
runtime is Node `24.14.0` while the repository declares `24.18.0`.
