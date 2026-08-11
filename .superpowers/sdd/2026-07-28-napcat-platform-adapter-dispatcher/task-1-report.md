# Task 1 Report: Platform Adapter Contracts And OneBot Mapping

## Status

Implemented and verified.

## Scope

Created the isolated `@kaguya/platform-adapters` package with:

- Platform adapter contracts for inbound messages, targets, senders, delivery receipts, and reply senders.
- OneBot message event normalization for QQ private and group messages.
- Stable session IDs: `qq:private:<user_id>` and `qq:group:<group_id>`.
- Stable trace IDs: `napcat:<self_id-or-unknown>:<message_id>`.
- OneBot private and group text send action builders.
- Degraded segment text for `reply`, `at`, `image`, `face`, text, and unknown segment types.
- Ignoring non-message events and blank normalized messages.

No NapCat transport, workflow changes, dispatcher, runtime wiring, media download, webhook, queue replay, or arbitration logic was added. The package imports only `@kaguya/schema` in production code.

## TDD Evidence

1. Private mapping and private action tests were written first. The red run failed because `./onebot.js` did not exist.
2. Minimal contracts and private behavior were implemented. The focused run passed `2/2` tests.
3. Group mapping, degraded segment text, ignore behavior, and group action tests were added before implementation. The red run failed in exactly two new behaviors: group action construction threw the intentional stub error, and group normalization returned `undefined`.
4. The OneBot implementation was extended to support the requested group and ignore behavior. The focused run passed `5/5` tests.

The brief's timestamp expectation was corrected per task resolution: OneBot `time` seconds are converted with `new Date(time * 1000).toISOString()`, so `1785200523` produces `2026-07-28T01:02:03.000Z`.

## Verification

- `pnpm vitest run packages/platform-adapters/src/onebot.test.ts`: passed, `5/5` tests.
- `pnpm --filter @kaguya/platform-adapters typecheck`: passed.
- `pnpm test`: passed, `27` files and `316` tests.
- `pnpm typecheck`: passed, including the web typecheck.

The commands were run with the bundled Node runtime prepended to `PATH`. pnpm emitted the repository's existing Node engine warning (`24.14.0` installed versus `24.18.0` requested); it did not affect verification.

## Files

- `packages/platform-adapters/package.json`
- `packages/platform-adapters/tsconfig.json`
- `packages/platform-adapters/src/types.ts`
- `packages/platform-adapters/src/onebot.ts`
- `packages/platform-adapters/src/index.ts`
- `packages/platform-adapters/src/onebot.test.ts`
- `tsconfig.json`
- `pnpm-lock.yaml`
