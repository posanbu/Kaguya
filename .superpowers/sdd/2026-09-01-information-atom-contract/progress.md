# SDD ledger — plan: docs/ours/superpowers/plans/2026-09-01-information-atom-contract.md

Base branch: `feature/information-atom-contract`
Approved design: `docs/ours/superpowers/specs/2026-09-01-information-atom-contract-design.md`

## Pre-flight plan scan

| Row | Task(s) | Shared file/interface | Finding and ruling |
|---|---|---|---|
| 1 | Task 1 → Task 2 | `InformationAtom`, `JsonObject` | Task 2 consumes the schemas/types produced by Task 1; ruling: keep atom definitions additive until final cleanup. |
| 2 | Task 2 → Task 3 | `InformationKindDefinition`, reference rules | Registry validates the exact definition object and relation names; ruling: Task 2 owns shape validation, Task 3 owns global uniqueness/reserved namespace. |
| 3 | Task 3 → Task 4 | `InformationAtomStore` | Database must structurally implement the engine port without runtime circular imports; ruling: add an explicit `@kaguya/engine` workspace dependency only for the exported port/errors. |
| 4 | Task 3 → Task 5 | post-commit subscription | Logger must never roll back a committed atom; ruling: bus reports subscriber errors to an emergency callback and Core does not undo storage. |
| 5 | Task 3 → Task 6 | Core append/subscribe | ModuleHost may append only after receiving a committed immutable atom; ruling: derive `core:caused-by` and `core:context` in the host and reject caller overrides. |
| 6 | Task 6 → Task 7 | module LLM executor | The staged reply module needs lifecycle atoms without coupling `@kaguya/modules` to Runtime; ruling: inject `InformationLlmLifecycleClient` through the module options. |
| 7 | Task 7 → Task 9 | LLM kind definitions | Task 7 creates only LLM definitions; Task 9 completes the aggregate; ruling: no duplicate kind definitions and engine tests use local run definitions. |
| 8 | Task 8 → Task 9 | run lifecycle definitions | Generic engine must not import Runtime; ruling: inject run definitions and runtime adapters rather than adding a dependency. |
| 9 | Task 4 → Task 9 | staged PostgreSQL database | Existing SQLite callers remain until Runtime switches; ruling: use `PostgresKaguyaDatabase` as a staged name, promote it in Task 11. |
| 10 | Task 5 → Task 9 | log projector | Module packages cannot import logger just for previews; ruling: project a `content` field and let logger produce the 168-code-point preview. |
| 11 | Task 9 → Task 10 | `KaguyaRuntimeOptions` | Server must pass URL while tests inject a database; ruling: use the plan's discriminated union and never log the URL. |
| 12 | Task 9 → Task 11 | final public exports | Legacy event files must stay until new Runtime path is green; ruling: remove/rename only after Task 10 verification. |
| 13 | Task 1 | `packages/schema/src/information.ts` tests vs implementation | Tests specify strict JSON, clone, and freeze behavior against the new module; ruling: write RED before implementation. |
| 14 | Task 2 | `information-kind.ts` tests vs implementation | Tests cover explicit log policy and namespaced relation; ruling: no implicit defaults. |
| 15 | Task 3 | Registry/Core tests vs implementation | Tests cover unknown/duplicate/sealed kinds, IDs, payloads, refs, and post-commit ordering; ruling: use real in-memory store, not mock assertions. |
| 16 | Task 4 | PostgreSQL tests vs staged files | Tests execute PGlite SQL and trigger behavior; ruling: retain old SQLite files only as a temporary downstream compatibility path. |
| 17 | Task 5 | logger tests vs projection code | Tests assert serialized output and 167/168/169 boundaries; ruling: no source-text-only assertions. |
| 18 | Task 6 | staged module tests vs host code | Tests assert derived references and run terminal facts; ruling: handler failures become failed run atoms. |
| 19 | Task 7 | detailed LLM tests vs staged client | Tests cover provider output/usage/duration and lifecycle sequence; ruling: preserve legacy wrapper until Task 11. |
| 20 | Task 8 | staged workflow tests vs engine | Tests assert started + one terminal atom and in-memory result; ruling: arbitrary node output stays out of run payload. |
| 21 | Task 9 | Runtime tests vs built-in aggregate | Tests assert exact kind list and complete message/delivery graph; ruling: module-owned definitions are imported, not redefined. |
| 22 | Task 10 | app tests vs URL config | Tests replace path defaults and secret-bearing fixtures; ruling: required URL is the only production database input. |
| 23 | Task 11 | removal test vs cleanup | The forbidden-symbol scan intentionally tests public removal; ruling: source scan is limited to production TypeScript and excludes historical docs/tests/dist. |
| 24 | Task 12 | mutation checklist vs full suite | Every listed mutation must have a failing test; ruling: add only concrete gap tests, no speculative behavior. |

Ruling: the staged replacements are required to keep the branch buildable between tasks; final names are promoted only after Runtime and application tests pass.

## Task status

- Task 1: complete — commits `66f523b`, `bc051b1`, `cd7888d`, `f1f03d6`, `b8c0aad`; scoped review approved
- Task 2: complete — commits `4a16546`, `f468fed`, `461942e`, `7e67916`, `42111f0`; scoped review approved
- Task 3: complete — commit `745f17c676aeea137d3e87e7cb73aefe25154edf`
- Task 4: complete — commit `4d5e0e6`
- Task 5: complete — commits `5c1b298`, `f902149`, `7d4eb60`; verification passed
- Task 6: pending
- Task 7: pending
- Task 8: pending
- Task 9: pending
- Task 10: pending
- Task 11: pending
- Task 12: pending
