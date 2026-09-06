# Task 3 report

Updated Runtime, Demo, and Server regression expectations for the speech timing DAG. The default delivery graph now asserts persisted `agent.turn.context.completed` and `agent.speech.decision` facts, with reply requests caused by the speech decision rather than inbound text.

Runtime fixtures that exercise model capability approval now activate the reply definition they provide, keeping preflight checks meaningful after the first-party activation list gained speech modules. The multi-reply delivery test runs through the default turn-context and speech-decision activations, while the consumer concurrency test observes speech decisions and retains the durable concurrent-consumer coverage.

## Verification

- `pnpm typecheck` — passed.
- `pnpm vitest run apps/demo/src/index.test.ts packages/runtime/src/runtime.test.ts` — 2 files passed, 27 tests passed.
- Earlier focused run including `apps/server/src/server-composition.test.ts` — passed for Server (16 tests); Demo and Runtime passed after expectation updates.
- `pnpm vitest run packages/modules/src/information-modules.test.ts` — 13 tests passed, including durable terminal replay returning the original speech decision and preserving one reply.

## Concerns

The complete `pnpm test` run was attempted. It first exposed the same built-in kind expectation regression; that expectation is now updated. The run was lengthy and was stopped before a clean completion, so focused suites provide the current verification evidence.
