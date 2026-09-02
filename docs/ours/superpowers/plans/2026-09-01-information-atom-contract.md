# Information Atom Contract and Kind Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Kaguya's parallel Core identities and SQLite record stores with immutable, registry-validated information atoms persisted in PostgreSQL.

**Architecture:** Add the atom wire contract to `@kaguya/schema`, kind definitions to `@kaguya/sdk`, and the sealed registry plus append/publish orchestration to `@kaguya/engine`. `@kaguya/database` implements the engine storage port with PostgreSQL, while Runtime registers the built-in kinds and expresses messages, decisions, runs, LLM calls, Memory facts, deliveries, and system logs as one append-only atom graph.

**Tech Stack:** Node.js 24.18.0, TypeScript 6 strict ESM, pnpm 11.9.0, Zod 4.4.3, Vitest 4.1.10, `pg`, Pino 10.3.1, and PGlite for isolated PostgreSQL tests.

**Spec:** `docs/ours/superpowers/specs/2026-09-01-information-atom-contract-design.md`

## Global Constraints

- This is a breaking Core upgrade. Do not retain `EventEnvelope`, `defineEvent`, mutable event interception, SQLite repositories, `databasePath`, or legacy Core-ID compatibility aliases in the final tree.
- `informationId` is the only identity of a Core fact. Workflow, node, module, provider, profile, and external platform IDs remain domain/configuration keys only.
- Every atom kind is registered before Core startup with a payload schema, reference rules, and an explicit log policy.
- Every created or modified source file must start with an accurate Chinese architecture header comment as required by `chinese-code-header-comments`.
- Production code follows strict TDD: add one behavioral test, run it and observe the expected failure, implement the minimum behavior, then rerun the focused test.
- Atom payloads and log projections contain JSON-compatible objects only. LLM prompts, raw model responses, credentials, database URLs, transport raw bodies, and headers never enter console projection fields.
- Message and system-log previews contain at most 168 Unicode code points, append `…` only when truncated, and report `contentLength` plus `contentTruncated`.
- PostgreSQL atoms and references are append-only. The database rejects `UPDATE` and `DELETE`; state changes append a new atom linked with a reserved relation.
- Runtime configuration requires `KAGUYA_DATABASE_URL`. No SQLite import or automatic data conversion is provided.
- The production database adapter uses `pg`. Tests use PGlite's real PostgreSQL engine and transaction API, following the official [PGlite API](https://pglite.dev/docs/api).

## Final File Structure

The final implementation should converge on these responsibilities:

- `packages/schema/src/information.ts`: atom, branded ID, reference, JSON object, and deep-readonly contracts and schemas.
- `packages/schema/src/index.ts`: re-export information contracts and retain non-Core prompt/platform schemas.
- `packages/sdk/src/information-kind.ts`: `defineInformationKind`, log policy, and per-relation rules.
- `packages/sdk/src/modules.ts`: atom-native module manifests, subscriptions, and handler context.
- `packages/engine/src/information-kind-registry.ts`: registration, reserved namespace enforcement, lookup, and sealing.
- `packages/engine/src/information-bus.ts`: immutable post-commit delivery without rewrite semantics.
- `packages/engine/src/information-core.ts`: ID generation, validation, persistence, freezing, and publish ordering.
- `packages/engine/src/module-host.ts`: atom-native module activation and targeted subscription dispatch after the legacy host is removed.
- `packages/engine/src/workflow-engine.ts`: run lifecycle emission through atom append operations after the legacy engine is removed.
- `packages/database/src/driver.ts`: common query/transaction abstraction and `pg` pool adapter after the staged PostgreSQL files are promoted.
- `packages/database/src/migrations.ts`: PostgreSQL schema, indexes, and append-only triggers.
- `packages/database/src/information-repository.ts`: kind synchronization, transactional append, reconstruction, and graph queries.
- `packages/database/src/index.ts`: async `KaguyaDatabase.connect`, lifecycle, and repository export after the staged class is promoted.
- `packages/database/src/testing.ts`: in-memory PGlite database factory used only by tests.
- `packages/logger/src/information.ts`: 168-code-point preview and kind log projection.
- `packages/runtime/src/information-kinds.ts`: Runtime-owned kinds plus the complete built-in definition aggregate and reserved relation rules.
- `packages/runtime/src/llm-lifecycle.ts`: requested/completed/failed LLM atom emission.
- `packages/runtime/src/runtime.ts`: PostgreSQL/Core composition and complete atom graph.
- `packages/modules/src/information-kinds.ts`: module-facing message, decision, and delivery definitions.
- `packages/modules/src/always-reply-filter.ts`: append filter decisions.
- `packages/modules/src/llm-reply.ts`: consume decisions, append assistant text, and request delivery.
- `apps/server/src/config.ts` and `apps/server/src/server.ts`: required PostgreSQL URL and async Runtime startup.
- `apps/demo/src/index.ts`: PostgreSQL-backed atom-chain demonstration.
- Public README and docs: replace SQLite/EventEnvelope/trace terminology with the delivered atom contract.

### Task 1: Add the immutable atom wire contract

**Files:**

- Create: `packages/schema/src/information.ts`
- Create: `packages/schema/src/information.test.ts`
- Modify: `packages/schema/src/index.ts`

**Interfaces:**

- Produces: `InformationId`, `InformationReference`, `InformationAtom<K, P>`, `JsonValue`, `JsonObject`, `DeepReadonly<T>`.
- Produces: `informationIdSchema`, `informationReferenceSchema`, `informationAtomSchema`, `jsonObjectSchema`, `parseInformationAtom`, and `freezeInformationAtom`.
- Keeps existing legacy record exports temporarily so downstream packages compile until Task 11 removes them.

- [ ] **Step 1: Write failing schema and alias-isolation tests**

Add tests whose expected literals are independent of production helpers:

```ts
it("rejects non-object and non-JSON payloads", () => {
  expect(() =>
    informationAtomSchema.parse({
      informationId: "atom-1",
      kind: "acme.message.created",
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { value: 1n },
      references: [],
    }),
  ).toThrow();
});

it("returns a deeply frozen snapshot", () => {
  const payload = { nested: { values: ["moon"] } };
  const atom = freezeInformationAtom({
    informationId: informationIdSchema.parse("atom-1"),
    kind: "acme.message.created",
    occurredAt: "2026-09-01T00:00:00.000Z",
    source: "module:acme",
    payload,
    references: [],
  });
  payload.nested.values[0] = "changed";
  expect(atom.payload).toEqual({ nested: { values: ["moon"] } });
  expect(Object.isFrozen(atom.payload.nested.values)).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run packages/schema/src/information.test.ts`

Expected: FAIL because `./information.js` and its exported contracts do not exist.

- [ ] **Step 3: Implement strict JSON validation and freezing**

Use a recursive Zod JSON schema and a clone-then-freeze boundary:

```ts
export const informationReferenceSchema = z
  .object({
    relation: z.string().trim().min(1),
    informationId: informationIdSchema,
  })
  .strict();

export const informationAtomSchema = z
  .object({
    informationId: informationIdSchema,
    kind: z.string().trim().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
    source: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/u),
    payload: jsonObjectSchema,
    references: z.array(informationReferenceSchema),
  })
  .strict();

export function freezeInformationAtom<K extends string, P extends JsonObject>(
  atom: InformationAtom<K, P>,
): InformationAtom<K, P> {
  return deepFreeze(structuredClone(atom));
}
```

The JSON parser must reject non-finite numbers, sparse arrays, custom prototypes, cycles, and every non-JSON JavaScript value. `deepFreeze` recursively visits plain objects and arrays only because validation has already excluded other prototypes.

- [ ] **Step 4: Run schema tests and package typecheck**

Run: `pnpm vitest run packages/schema/src/information.test.ts packages/schema/src/index.test.ts`

Run: `pnpm --filter @kaguya/schema typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the atom schema slice**

```bash
git add packages/schema/src/information.ts packages/schema/src/information.test.ts packages/schema/src/index.ts
git commit -m "feat(schema): add immutable information atom contract"
```

### Task 2: Define information kinds and reference policies

**Files:**

- Create: `packages/sdk/src/information-kind.ts`
- Create: `packages/sdk/src/information-kind.test.ts`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**

- Consumes: `InformationAtom`, `InformationId`, `JsonObject` from Task 1.
- Produces: `InformationKindDefinition<K, P>`, `InformationReferenceRule`, `InformationLogPolicy<P>`, `InformationLogProjection`, and `defineInformationKind`.
- Produces: `InformationAppendInput<K, P>` without an `informationId` property.

- [ ] **Step 1: Write failing definition tests**

```ts
it("requires a schema, declared references, and explicit logging", () => {
  const definition = defineInformationKind({
    kind: "acme.message.created",
    payloadSchema: z.object({ text: z.string() }).strict(),
    references: {
      "acme:parent": {
        required: true,
        multiple: false,
        targetKinds: ["acme.message.parent"],
      },
    },
    log: { enabled: false },
  });
  expect(Object.isFrozen(definition)).toBe(true);
  expect(definition.references["acme:parent"]?.targetKinds).toEqual([
    "acme.message.parent",
  ]);
});

it("rejects malformed relation names", () => {
  expect(() =>
    defineInformationKind({
      kind: "acme.message.created",
      payloadSchema: z.object({}).strict(),
      references: { parent: { required: false, multiple: false } },
      log: { enabled: false },
    }),
  ).toThrow(/namespace/iu);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run packages/sdk/src/information-kind.test.ts`

Expected: FAIL because `defineInformationKind` is not exported.

- [ ] **Step 3: Implement definition validation and immutable snapshots**

```ts
export function defineInformationKind<
  const K extends string,
  P extends JsonObject,
>(input: DefineInformationKindInput<K, P>): InformationKindDefinition<K, P> {
  assertKindName(input.kind);
  const references = cloneAndValidateReferenceRules(input.references);
  const log = cloneAndValidateLogPolicy(input.log);
  return Object.freeze({
    kind: input.kind,
    payloadSchema: input.payloadSchema,
    references,
    log,
  });
}
```

Validate custom relations with `^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$`. Accept the five reserved `core:` names syntactically here; Task 3 enforces who may register them. Reject duplicate target kinds and empty target-kind arrays.

- [ ] **Step 4: Verify the SDK slice**

Run: `pnpm vitest run packages/sdk/src/information-kind.test.ts packages/sdk/src/index.test.ts`

Run: `pnpm --filter @kaguya/sdk typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the kind-definition slice**

```bash
git add packages/sdk/src/information-kind.ts packages/sdk/src/information-kind.test.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): define information kinds"
```

### Task 3: Build the sealed Registry, post-commit bus, and InformationCore

**Files:**

- Create: `packages/engine/src/information-errors.ts`
- Create: `packages/engine/src/information-kind-registry.ts`
- Create: `packages/engine/src/information-kind-registry.test.ts`
- Create: `packages/engine/src/information-bus.ts`
- Create: `packages/engine/src/information-bus.test.ts`
- Create: `packages/engine/src/information-core.ts`
- Create: `packages/engine/src/information-core.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**

- Consumes: atom and kind contracts from Tasks 1–2.
- Produces: `InformationKindRegistry.register`, `registerBuiltin`, `seal`, `get`, and `definitions`.
- Produces: `InformationAtomStore.synchronizeKinds`, `append`, `getById`, and `listByReference` as the engine-owned storage port.
- Produces: `InformationCore.start`, `append`, `getById`, `subscribe`, `subscribeAll`, and `close`.

- [ ] **Step 1: Write Registry failure tests**

```ts
it("rejects duplicate, unknown, reserved, and post-seal registrations", () => {
  const registry = new InformationKindRegistry();
  registry.register(customDefinition);
  expect(() => registry.register(customDefinition)).toThrow(
    DuplicateInformationKindError,
  );
  expect(() => registry.get("acme.unknown")).toThrow(
    UnknownInformationKindError,
  );
  expect(() => registry.register(coreDefinition)).toThrow(/reserved/iu);
  registry.seal();
  expect(() => registry.register(otherDefinition)).toThrow(
    InformationRegistrySealedError,
  );
});
```

- [ ] **Step 2: Run the Registry test and verify RED**

Run: `pnpm vitest run packages/engine/src/information-kind-registry.test.ts`

Expected: FAIL because Registry classes do not exist.

- [ ] **Step 3: Implement Registry and errors, then verify GREEN**

`registerBuiltin` must accept only `core.*`; `register` must reject `core.*`. Both reject an existing key. `definitions()` returns a frozen array snapshot, not the internal Map.

Run: `pnpm vitest run packages/engine/src/information-kind-registry.test.ts`

Expected: PASS.

- [ ] **Step 4: Write failing bus and Core tests**

Use a real in-memory store double that stores frozen atoms and validates expected reference targets; do not assert on mock call counts.

```ts
it("persists before publishing and isolates observer failures", async () => {
  const order: string[] = [];
  const store = new MemoryInformationStore({
    onAppend: () => order.push("store"),
  });
  const core = createStartedCore(store, [parentDefinition]);
  core.subscribe(parentDefinition, () => {
    order.push("observer");
    throw new Error("observer failed");
  });
  const atom = await core.append(parentDefinition, {
    occurredAt: "2026-09-01T00:00:00.000Z",
    source: "module:acme",
    payload: { text: "moon" },
    references: [],
  });
  expect(order).toEqual(["store", "observer"]);
  expect((await store.getById(atom.informationId))?.payload).toEqual({
    text: "moon",
  });
});
```

Add independent tests for unknown definitions, invalid transformed payloads, missing/duplicate/undeclared references, required/multiple/target-kind rules, deterministic IDs, invalid IDs, collision errors, input alias mutation, and deep read freezing.

- [ ] **Step 5: Run bus/Core tests and verify RED**

Run: `pnpm vitest run packages/engine/src/information-bus.test.ts packages/engine/src/information-core.test.ts`

Expected: FAIL because the bus and Core are absent.

- [ ] **Step 6: Implement the append pipeline**

```ts
export interface InformationAtomStore {
  synchronizeKinds(kinds: readonly string[]): Promise<void>;
  append(
    atom: InformationAtom,
    expectations: readonly InformationReferenceExpectation[],
  ): Promise<void>;
  getById(informationId: InformationId): Promise<InformationAtom | undefined>;
  listByReference(query: InformationReferenceQuery): Promise<InformationAtom[]>;
}

export class InformationCore {
  async append<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: InformationAppendInput<K, P>,
  ): Promise<InformationAtom<K, P>> {
    this.assertStarted();
    this.registry.assertRegistered(definition);
    const atom = this.buildAndValidateAtom(definition, input);
    await this.store.append(atom, expectationsFor(definition, atom.references));
    await this.bus.publish(atom);
    return atom;
  }
}
```

The bus clones and freezes once at its boundary, delivers same-kind subscribers in registration order, and reports subscriber failures through `onSubscriberError` without rejecting a successfully committed append. `InformationCore.close()` stops new appends and clears subscriptions; storage lifecycle remains owned by the Runtime composition root.

- [ ] **Step 7: Verify engine behavior and types**

Run: `pnpm vitest run packages/engine/src/information-kind-registry.test.ts packages/engine/src/information-bus.test.ts packages/engine/src/information-core.test.ts`

Run: `pnpm --filter @kaguya/engine typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the Core slice**

```bash
git add packages/engine/src/information-*.ts packages/engine/src/index.ts
git commit -m "feat(engine): add information core and registry"
```

### Task 4: Implement the PostgreSQL append-only repository

**Files:**

- Modify: `packages/database/package.json`
- Modify: `packages/database/tsconfig.json`
- Create: `packages/database/src/postgres-driver.ts`
- Create: `packages/database/src/postgres-migrations.ts`
- Create: `packages/database/src/information-repository.ts`
- Create: `packages/database/src/postgres-index.test.ts`
- Create: `packages/database/src/information-repository.test.ts`
- Create: `packages/database/src/testing.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/database/package.json` exports for `./testing`

**Interfaces:**

- Consumes: `InformationAtomStore` and reference expectation/query types from Task 3.
- Produces: staged async `PostgresKaguyaDatabase.connect({ connectionString })`, `.information`, `.migrate()`, and `.close()` while the old SQLite `KaguyaDatabase` remains available to unchanged callers.
- Produces: `createTestingDatabase()` backed by an isolated in-memory PGlite instance.
- Task 11 removes the SQLite class/files and promotes `PostgresKaguyaDatabase` to the final public name `KaguyaDatabase`.

- [ ] **Step 1: Add production and test database dependencies**

Run:

```bash
pnpm --filter @kaguya/database add pg
pnpm --filter @kaguya/database add '@kaguya/engine@workspace:*'
pnpm --filter @kaguya/database add -D @types/pg @electric-sql/pglite
```

Expected: `packages/database/package.json` and `pnpm-lock.yaml` include the PostgreSQL driver and the isolated PostgreSQL test runtime.

- [ ] **Step 2: Write failing migration and repository tests**

The tests must execute SQL, not inspect SQL source text:

```ts
it("rolls back an atom when a target reference is missing", async () => {
  const database = await createTestingDatabase();
  await database.migrate();
  await database.information.synchronizeKinds([
    "core.runtime.context",
    "core.message.inbound.text",
  ]);
  await expect(
    database.information.append(inboundAtom, [
      {
        relation: "core:context",
        informationId: informationIdSchema.parse("missing-context"),
        targetKinds: ["core.runtime.context"],
      },
    ]),
  ).rejects.toThrow(InvalidInformationReferenceError);
  expect(
    await database.information.getById(inboundAtom.informationId),
  ).toBeUndefined();
});
```

Add tests that execute direct `UPDATE` and `DELETE` statements and expect PostgreSQL errors, plus kind-set mismatch, JSONB round-trip, reference order, target-kind mismatch, ID conflict, reverse-reference query order, and two concurrent appends with the same ID.

- [ ] **Step 3: Run repository tests and verify RED**

Run: `pnpm vitest run packages/database/src/postgres-index.test.ts packages/database/src/information-repository.test.ts`

Expected: FAIL because the PostgreSQL database entry point and repository do not exist.

- [ ] **Step 4: Implement the query abstraction and pg adapter**

```ts
export interface SqlTransaction {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
}

export interface SqlDatabase extends SqlTransaction {
  exec(sql: string): Promise<void>;
  transaction<Result>(
    run: (tx: SqlTransaction) => Promise<Result>,
  ): Promise<Result>;
  close(): Promise<void>;
}
```

`PgDatabase` acquires one Pool client for a transaction, executes `BEGIN`, commits on success, rolls back on failure, releases in `finally`, and calls `pool.end()` from `close`. `PGliteDatabase` delegates to PGlite's callback transaction and closes the WASM database.

- [ ] **Step 5: Implement PostgreSQL migrations and mutation guards**

Create `kaguya_schema_migrations`, `information_kinds`, `information_atoms`, and `information_references`, both required indexes, and one PL/pgSQL trigger function:

```sql
CREATE FUNCTION kaguya_reject_information_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'information atoms are append-only';
END;
$$;
```

Attach `BEFORE UPDATE OR DELETE` triggers to `information_atoms` and `information_references`. Use `ON DELETE RESTRICT` explicitly on both atom foreign keys. Keep schema migration execution transactional and idempotent.

- [ ] **Step 6: Implement kind synchronization, append, and graph reads**

`append` inserts the atom, reads all distinct targets with one `SELECT ... WHERE information_id = ANY($1)`, compares target kinds to expectations, inserts ordered references, and commits. Map PostgreSQL SQLSTATE `23505` on `information_atoms_pkey` to `InformationIdConflictError`; preserve all other driver failures as `InformationStoreError` with the original error as `cause`.

- [ ] **Step 7: Verify the PostgreSQL package**

Run: `pnpm vitest run packages/database/src/index.test.ts packages/database/src/postgres-index.test.ts packages/database/src/information-repository.test.ts`

Run: `pnpm --filter @kaguya/database typecheck`

Run: `pnpm typecheck`

Expected: PASS. SQLite remains only on the legacy path until Task 11, so every intermediate commit stays buildable.

- [ ] **Step 8: Commit the PostgreSQL repository**

```bash
git add packages/database pnpm-lock.yaml
git commit -m "feat(database): persist information atoms in postgres"
```

### Task 5: Add atom-driven log projection and the 168-character contract

**Files:**

- Modify: `packages/logger/package.json`
- Create: `packages/logger/src/information.ts`
- Create: `packages/logger/src/information.test.ts`
- Modify: `packages/logger/src/index.ts`

**Interfaces:**

- Consumes: `InformationAtom` and `InformationKindDefinition`.
- Produces: `MAX_INFORMATION_CONTENT_CODE_POINTS = 168`, `previewInformationContent`, and `projectInformationAtomLog`.
- Produces: `InformationAtomLogSink` that can be registered with `InformationCore.subscribeAll`.

- [ ] **Step 1: Write failing preview boundary and projection tests**

```ts
it.each([
  ["月".repeat(167), 167, false, "月".repeat(167)],
  ["月".repeat(168), 168, false, "月".repeat(168)],
  ["月".repeat(169), 169, true, `${"月".repeat(168)}…`],
])("truncates by Unicode code point", (input, length, truncated, preview) => {
  expect(previewInformationContent(input)).toEqual({
    contentPreview: preview,
    contentLength: length,
    contentTruncated: truncated,
  });
});

it("logs projected fields with the atom identity", async () => {
  await projectInformationAtomLog(logger, definition, atom);
  expect(readJsonLine(stream)).toMatchObject({
    informationId: "atom-1",
    kind: "core.message.inbound.text",
    source: "runtime:web",
    contentPreview: "hello moon",
  });
});
```

Include a surrogate-pair fixture, preserved newline, escaped NUL/control characters, disabled policy, all four levels, invalid projector result, and assertions that prompt/response/credentials/raw/headers never occur in serialized output.

- [ ] **Step 2: Run logger tests and verify RED**

Run: `pnpm vitest run packages/logger/src/information.test.ts`

Expected: FAIL because the information logger does not exist.

- [ ] **Step 3: Implement safe preview and projection**

First add the contract dependencies:

```bash
pnpm --filter @kaguya/logger add '@kaguya/schema@workspace:*' '@kaguya/sdk@workspace:*'
```

Count with `Array.from(input)`, slice the first 168 code points, escape C0 controls other than `\n` and `\t`, and append one ellipsis only when the original code-point length exceeds 168. Automatically merge the four identity fields after projector validation so a projector cannot replace them.

Projection errors call an injected emergency reporter with only `{ informationId, kind, errorType }`; they do not throw back into `InformationCore.append` and never append another `core.log.error` atom.

- [ ] **Step 4: Verify logger tests and types**

Run: `pnpm vitest run packages/logger/src/information.test.ts packages/logger/src/index.test.ts`

Run: `pnpm --filter @kaguya/logger typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the logging slice**

```bash
git add packages/logger packages/logger/package.json pnpm-lock.yaml
git commit -m "feat(logger): project information atom logs"
```

### Task 6: Convert module definitions and ModuleHost to immutable atoms

**Files:**

- Create: `packages/sdk/src/information-modules.ts`
- Create: `packages/sdk/src/information-modules.test.ts`
- Modify: `packages/sdk/src/index.ts`
- Create: `packages/engine/src/information-module-host.ts`
- Create: `packages/engine/src/information-module-host.test.ts`
- Create: `packages/modules/src/information-kinds.ts`
- Create: `packages/modules/src/always-reply-information-filter.ts`
- Create: `packages/modules/src/llm-information-reply.ts`
- Modify: `packages/modules/src/index.ts`
- Create: `packages/modules/src/information-modules.test.ts`

**Interfaces:**

- Consumes: `InformationCore`, kind definitions, immutable atoms.
- Produces staged atom-native contracts `InformationModuleDefinition`, `onInformation`, `onTargetedInformation`, and `InformationModuleHandlerContext.append` alongside the old event module API.
- Produces `InformationModuleRunLifecycle`, an injected port that appends started/completed/failed/cancelled facts around each module handler without making Engine import Runtime kind definitions.
- Produces module kinds for inbound text, filter decision, assistant text, and delivery request.
- Task 11 deletes the event-native files and promotes the staged atom-native names to `ModuleDefinition`, `ModuleHost`, `alwaysReplyFilterModule`, and `createLlmReplyModule`.

- [ ] **Step 1: Write failing SDK and ModuleHost tests**

```ts
it("appends a derived atom with causal and context references", async () => {
  const observed: InformationAtom[] = [];
  const module = defineModule({
    manifest: {
      apiVersion: 1,
      definitionId: "acme.echo",
      displayName: "Echo",
      settingsSchema: z.object({}).strict(),
      informationKinds: [replyKind],
    },
    create: () => ({
      subscriptions: [
        onInformation(inboundKind, async (atom, context) => {
          observed.push(
            await context.append(replyKind, {
              payload: { text: atom.payload.text },
            }),
          );
        }),
      ],
    }),
  });
  await startHostWith(module).publish(inboundAtom);
  expect(observed[0]?.references).toEqual([
    { relation: "core:caused-by", informationId: inboundAtom.informationId },
    { relation: "core:context", informationId: contextAtom.informationId },
  ]);
});
```

Add tests for missing target instance, mixed targeted/broadcast subscriptions, conflicting definition objects for one kind, undeclared module output kind, immutable source atoms, and exactly one terminal run fact after each started handler run.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run packages/sdk/src/information-modules.test.ts packages/engine/src/information-module-host.test.ts packages/modules/src/information-modules.test.ts`

Expected: FAIL because the atom-native parallel module APIs do not exist.

- [ ] **Step 3: Refactor SDK module contracts**

```ts
export interface InformationModuleHandlerContext {
  readonly definitionId: string;
  readonly instanceId: string;
  readonly sourceAtom: InformationAtom;
  now(): Date;
  append<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: Omit<
      InformationAppendInput<K, P>,
      "occurredAt" | "source" | "references"
    > & {
      readonly references?: readonly InformationReference[];
    },
  ): Promise<InformationAtom<K, P>>;
}
```

The host supplies `occurredAt`, `source: module:<instanceId>`, `core:caused-by`, and inherited `core:context`. It rejects caller attempts to duplicate or replace those reserved relations. It calls the injected `InformationModuleRunLifecycle.started()` before a handler and exactly one of `completed()`, `failed()`, or `cancelled()` afterward; the Runtime adapter created in Task 9 implements those operations with `core.run.*` atoms.

- [ ] **Step 4: Define module payload schemas and behavior**

`core.filter.decision` payload is `{ shouldReply, reason, targetInstanceId? }`. The staged always-reply information module appends a true decision targeted at the configured reply instance. The staged reply information module consumes that decision, loads the causal inbound atom through `InformationCore.getById`, calls its LLM executor, appends `core.message.assistant.text`, then appends `core.delivery.requested` caused by the assistant message.

Message payloads retain platform/request metadata needed for delivery, but external IDs remain payload values and never become atom identities.

- [ ] **Step 5: Verify module behavior and package types**

Run: `pnpm vitest run packages/sdk/src/information-modules.test.ts packages/engine/src/information-module-host.test.ts packages/modules/src/information-modules.test.ts`

Run: `pnpm --filter @kaguya/sdk typecheck`

Run: `pnpm --filter @kaguya/engine typecheck`

Run: `pnpm --filter @kaguya/modules typecheck`

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the module migration**

```bash
git add packages/sdk/src/information-modules.ts packages/sdk/src/information-modules.test.ts packages/sdk/src/index.ts packages/engine/src/information-module-host.ts packages/engine/src/information-module-host.test.ts packages/engine/src/index.ts packages/modules/src
git commit -m "refactor(modules): consume and append information atoms"
```

### Task 7: Replace LLM trace records with lifecycle atoms

**Files:**

- Modify: `packages/llm/src/client.ts`
- Modify: `packages/llm/src/index.test.ts`
- Create: `packages/runtime/src/information-kinds.ts` with the three LLM lifecycle definitions
- Create: `packages/runtime/src/information-kinds.test.ts` with initial LLM definition tests
- Create: `packages/runtime/src/information-llm-lifecycle.ts`
- Create: `packages/runtime/src/information-llm-lifecycle.test.ts`

**Interfaces:**

- Produces: staged `KaguyaLlmClient.generateDetailed()` returning `KaguyaLlmGeneration<T> = { output, usage?, durationMs }` from the low-level client.
- Consumes: `core.llm.requested/completed/failed` definitions and `InformationCore`.
- Produces staged `InformationLlmLifecycleClient.generate(request, contextAtom, causedByAtom)` returning validated output while appending lifecycle atoms.
- Keeps legacy `generate()` and trace-writer options until Task 11 so the pre-migration Runtime remains buildable; Task 11 removes tracing and promotes `generateDetailed()` to `generate()`.
- Keeps the event-native `LlmLifecycleClient` until Task 11; Task 9 uses the staged information client.

- [ ] **Step 1: Write failing low-level client tests without trace mocks**

```ts
it("returns validated output, usage, and duration without persistence", async () => {
  const generation = await new KaguyaLlmClient({
    model,
    now: sequenceClock([
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T00:00:00.025Z",
    ]),
  }).generateDetailed(request);
  expect(generation).toEqual({
    output: { text: "Moonlight." },
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    durationMs: 25,
  });
});
```

Keep the existing legacy trace tests during this staged task. Add the new detailed-generation tests without trace mocks, and retain output validation, retryable/non-retryable/cancelled classification, and safe error messages.

- [ ] **Step 2: Run LLM client tests and verify RED**

Run: `pnpm vitest run packages/llm/src/index.test.ts`

Expected: FAIL because `generateDetailed` does not exist.

- [ ] **Step 3: Refactor the low-level client**

Extract provider invocation, duration measurement, usage normalization, and output validation into `generateDetailed`. Make `traceWriter` optional for callers that use only `generateDetailed`. Keep the existing `generate` wrapper and legacy tracing types in this task; the wrapper must reject construction/calls without a trace writer and must call the shared detailed-generation path before writing its legacy trace. Preserve `KaguyaLlmError` classification.

- [ ] **Step 4: Write failing lifecycle-atom tests**

Test success and each failure class with a real in-memory InformationCore. Assert the literal kind sequence and relations:

```ts
expect(observed.map(({ kind }) => kind)).toEqual([
  "core.llm.requested",
  "core.llm.completed",
]);
expect(observed[1]?.references).toContainEqual({
  relation: "core:status-of",
  informationId: observed[0]?.informationId,
});
```

Assert stored completed payload includes normalized usage/output, while log projection excludes prompt and output.

- [ ] **Step 5: Implement lifecycle atom emission and verify GREEN**

Append requested before provider invocation. On success append completed with `core:status-of`, `core:caused-by`, and `core:context`. On failure append failed with safe name/kind/message and rethrow the original classified `KaguyaLlmError`.

Run: `pnpm vitest run packages/llm/src/index.test.ts packages/runtime/src/information-llm-lifecycle.test.ts`

Run: `pnpm --filter @kaguya/llm typecheck`

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the LLM lifecycle migration**

```bash
git add packages/llm/src packages/runtime/src/information-kinds.ts packages/runtime/src/information-kinds.test.ts packages/runtime/src/information-llm-lifecycle.ts packages/runtime/src/information-llm-lifecycle.test.ts
git commit -m "refactor(llm): record lifecycle as information atoms"
```

### Task 8: Emit workflow run state as append-only atoms

**Files:**

- Create: `packages/sdk/src/information-execution.ts`
- Create: `packages/sdk/src/information-execution.test.ts`
- Modify: `packages/sdk/src/index.ts`
- Create: `packages/engine/src/information-workflow-engine.ts`
- Create: `packages/engine/src/information-workflow-engine.test.ts`
- Create: `packages/runtime/src/information-failure-semantics.test.ts`

**Interfaces:**

- Produces staged `InformationExecutionContext` with `sourceAtom`, `contextAtom`, `now`, `append`, and `services`.
- Produces staged `InformationWorkflowEngine` with injected run kind definitions and Core append operations.
- Keeps `WorkflowExecutionResult.workflowId`, `completedNodeIds`, and in-memory outputs because these are execution results, not Core fact identities.
- Task 11 deletes the event-recording workflow engine and promotes these staged names to `ExecutionContext` and `WorkflowEngine`.
- Engine tests define strict local `core.run.*` definitions; the production Runtime definitions are completed and injected in Task 9, avoiding an engine-to-runtime dependency.

- [ ] **Step 1: Write failing started/terminal atom tests**

```ts
it("appends started and completed atoms without rewriting the started atom", async () => {
  const result = await engine.run(workflow, input, context);
  const runAtoms = observed.filter(({ kind }) => kind.startsWith("core.run."));
  expect(runAtoms.map(({ kind }) => kind)).toEqual([
    "core.run.started",
    "core.run.completed",
  ]);
  expect(runAtoms[1]?.references).toContainEqual({
    relation: "core:status-of",
    informationId: runAtoms[0]?.informationId,
  });
  expect(result.completedNodeIds).toEqual(["first-node"]);
});
```

Add failed, retryable, cancelled, terminal-append failure, ambiguous entry, edge order, and immutable source tests.

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `pnpm vitest run packages/engine/src/information-workflow-engine.test.ts packages/runtime/src/information-failure-semantics.test.ts`

Expected: FAIL because the atom-native workflow engine does not exist.

- [ ] **Step 3: Implement atom-native workflow recording**

Append `core.run.started` immediately before each node. Append exactly one completed/failed/cancelled atom afterward, caused by the source atom, connected to the context, and linked to started with `core:status-of`. Do not persist arbitrary node output in run payload; downstream facts carry validated output through their own kinds.

- [ ] **Step 4: Verify workflow and SDK types**

Run: `pnpm vitest run packages/engine/src/information-workflow-engine.test.ts packages/runtime/src/information-failure-semantics.test.ts`

Run: `pnpm --filter @kaguya/sdk typecheck`

Run: `pnpm --filter @kaguya/engine typecheck`

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the workflow lifecycle migration**

```bash
git add packages/sdk/src/information-execution.ts packages/sdk/src/information-execution.test.ts packages/sdk/src/index.ts packages/engine/src/information-workflow-engine.ts packages/engine/src/information-workflow-engine.test.ts packages/engine/src/index.ts packages/runtime/src/information-failure-semantics.test.ts
git commit -m "refactor(engine): append workflow run atoms"
```

### Task 9: Recompose Runtime around the atom graph

**Files:**

- Modify: `packages/runtime/src/information-kinds.ts`
- Modify: `packages/runtime/src/information-kinds.test.ts`
- Replace: `packages/runtime/src/runtime.ts`
- Replace: `packages/runtime/src/runtime.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**

- Produces Runtime-owned context/run/LLM/Memory/log definitions and the ordered `builtInInformationKinds` tuple, which aggregates those definitions with the message/filter/delivery definitions owned by `@kaguya/modules`; no kind is defined twice.
- Replaces `KaguyaRuntimeOptions.databasePath` with `databaseUrl` or an injected testing database.
- Replaces `RuntimeDispatchResult.traceId` with `contextInformationId` and `messageInformationId?`.
- Preserves transport registration, model selection, gateway allowlist, dispatch/close lifecycle, and delivery receipts.

- [ ] **Step 1: Write failing kind registration and Memory contract tests**

Assert the exact built-in kind list from the design. Build real atoms through InformationCore and verify:

- `core.memory.recalled` requires one or more `core:memory` references to `core.memory.stored`.
- `core.memory.invalidated` requires one `core:status-of` stored target.
- a replacement `core.memory.stored` accepts one `core:supersedes` stored target.
- all built-in kinds have an explicit log policy.

- [ ] **Step 2: Run built-in contract tests and verify RED**

Run: `pnpm vitest run packages/runtime/src/information-kinds.test.ts`

Expected: FAIL because the complete built-in aggregate and the context/Memory/log definitions do not exist yet.

- [ ] **Step 3: Define payloads, references, and log projectors**

Use strict payload schemas. Message payloads include `text` and normalized source data. LLM requested payload stores the compiled prompt for audit, completed stores output/usage/duration, but their projectors emit only model/workflow/node/status fields. Delivery payloads include adapter/platform/destination/message or safe receipt/error fields. `core.log.*` projectors pass the 168-character `message` preview through the logger helper.

- [ ] **Step 4: Write failing end-to-end Runtime tests**

Use `createTestingDatabase()` and deterministic model/ID/time providers. Verify the literal graph for:

- web inbound → context → inbound text → decision → run → LLM → assistant text;
- platform inbound → the same chain → delivery requested → delivered;
- transport failure → delivery failed linked to the request;
- gateway denial → context plus false filter decision, with no stored message body;
- concurrent dispatch and graceful close;
- unknown module kind and post-start registration rejection.

Query by `core:context`, not by direct repository tables or trace IDs.

- [ ] **Step 5: Run Runtime tests and verify RED**

Run: `pnpm vitest run packages/runtime/src/runtime.test.ts`

Expected: FAIL because Runtime still composes SQLite records and EventBus.

- [ ] **Step 6: Implement async PostgreSQL/Core startup**

```ts
export type KaguyaRuntimeOptions = {
  readonly logger?: KaguyaLogger;
  readonly now?: () => Date;
  readonly informationIdGenerator?: InformationIdGenerator;
  readonly resolveModelSelection?: RuntimeModelSelectionResolver;
  readonly moduleDefinitions?: readonly InformationModuleDefinition[];
  readonly moduleActivations?: readonly ModuleActivation[];
  readonly gatewayAllowlist?: GatewayAllowlist;
} & (
  | { readonly databaseUrl: string; readonly database?: never }
  | { readonly database: PostgresKaguyaDatabase; readonly databaseUrl?: never }
);
```

Runtime start creates Registry, registers built-ins and all information-module manifest kinds, starts InformationCore, attaches the atom logger, creates the `core.run.*` adapter required by `InformationModuleRunLifecycle`, creates `InformationModuleHost`, then starts modules. Runtime close stops admission, waits in-flight dispatches, stops modules, unsubscribes, and closes only a database instance it owns. Task 11 promotes the staged database and module-host names without changing Runtime behavior.

- [ ] **Step 7: Implement dispatch and delivery atom chains**

Create context first. Allowed messages append inbound text and let ModuleHost append downstream facts. Denied platform messages append only a safe context and false filter decision. The delivery subscriber persists requested status before calling transport and appends delivered/failed afterward. Runtime results derive receipts by querying atoms related to the context.

- [ ] **Step 8: Verify Runtime and dependency packages**

Run: `pnpm vitest run packages/runtime/src/information-kinds.test.ts packages/runtime/src/runtime.test.ts packages/runtime/src/information-llm-lifecycle.test.ts`

Run: `pnpm --filter @kaguya/runtime typecheck`

Expected: PASS.

- [ ] **Step 9: Commit the Runtime migration**

```bash
git add packages/runtime/src
git commit -m "refactor(runtime): compose the information atom graph"
```

### Task 10: Switch Server and demo configuration to PostgreSQL

**Files:**

- Modify: `apps/server/src/config.ts`
- Replace: `apps/server/src/config.test.ts`
- Modify: `apps/server/src/server.ts`
- Replace: `apps/server/src/server-composition.test.ts`
- Modify: `apps/server/src/app.test.ts`
- Replace: `apps/demo/src/index.ts`
- Replace: `apps/demo/src/index.test.ts`

**Interfaces:**

- Produces: `ServerConfig.databaseUrl: string` from required `KAGUYA_DATABASE_URL`.
- Removes: `ServerConfig.databasePath`, `KAGUYA_DATABASE_PATH`, and `KAGUYA_DEMO_DATABASE_PATH`.
- Produces: demo output keyed by context `informationId` and atom counts by kind.

- [ ] **Step 1: Write failing server configuration tests**

```ts
it("requires the PostgreSQL URL", () => {
  expect(() =>
    readServerConfig({
      KAGUYA_GATEWAY_TOKEN: "0123456789abcdef",
    }),
  ).toThrow("KAGUYA_DATABASE_URL is required");
});

it("reads the PostgreSQL URL without exposing it elsewhere", () => {
  const config = readServerConfig({
    KAGUYA_GATEWAY_TOKEN: "0123456789abcdef",
    KAGUYA_DATABASE_URL: "postgresql://kaguya:secret@localhost/kaguya",
  });
  expect(config.databaseUrl).toBe(
    "postgresql://kaguya:secret@localhost/kaguya",
  );
  expect(config).not.toHaveProperty("databasePath");
});
```

- [ ] **Step 2: Run app tests and verify RED**

Run: `pnpm vitest run apps/server/src/config.test.ts apps/server/src/server-composition.test.ts apps/server/src/app.test.ts apps/demo/src/index.test.ts`

Expected: FAIL because app composition still supplies SQLite paths.

- [ ] **Step 3: Implement required URL composition**

Server passes `databaseUrl` to Runtime. Startup failure emergency logs include only the error class/code, never `config.databaseUrl` or a raw `pg` error object. Composition tests inject `createTestingDatabase()` rather than opening files in temporary directories.

The demo reads required `KAGUYA_DATABASE_URL`, dispatches one deterministic message, then queries `database.information.listByReference({ relation: "core:context", targetInformationId })` and prints context ID plus per-kind counts.

- [ ] **Step 4: Verify Server and demo behavior**

Run: `pnpm vitest run apps/server/src/config.test.ts apps/server/src/server-composition.test.ts apps/server/src/app.test.ts apps/demo/src/index.test.ts`

Run: `pnpm --filter @kaguya/server typecheck`

Run: `pnpm --filter @kaguya/demo typecheck`

Expected: PASS and serialized startup failures do not contain `secret`.

- [ ] **Step 5: Commit app composition changes**

```bash
git add apps/server/src apps/demo/src
git commit -m "refactor(apps): require postgres information storage"
```

### Task 11: Remove the legacy identity model and update public documentation

**Files:**

- Modify: `packages/schema/src/index.ts`
- Modify: `packages/schema/src/index.test.ts`
- Delete: `packages/sdk/src/modules.ts`
- Rename: `packages/sdk/src/information-modules.ts` to `packages/sdk/src/modules.ts`
- Rename: `packages/sdk/src/information-execution.ts` exports to final `ExecutionContext` names
- Modify: `packages/sdk/src/index.ts`
- Delete: `packages/engine/src/event-bus.ts`
- Delete: `packages/engine/src/event-bus.test.ts`
- Delete: `packages/engine/src/module-host.ts`
- Delete: `packages/engine/src/module-host.test.ts`
- Rename: `packages/engine/src/information-module-host.ts` to `packages/engine/src/module-host.ts`
- Rename: `packages/engine/src/information-module-host.test.ts` to `packages/engine/src/module-host.test.ts`
- Delete: `packages/engine/src/workflow-engine.ts`
- Delete: `packages/engine/src/workflow-engine.test.ts`
- Rename: `packages/engine/src/information-workflow-engine.ts` to `packages/engine/src/workflow-engine.ts`
- Rename: `packages/engine/src/information-workflow-engine.test.ts` to `packages/engine/src/workflow-engine.test.ts`
- Modify: `packages/engine/src/index.ts`
- Delete: `packages/database/src/migrations.ts`
- Delete: `packages/database/src/repositories.ts`
- Delete: `packages/database/src/index.test.ts`
- Rename: `packages/database/src/postgres-driver.ts` to `packages/database/src/driver.ts`
- Rename: `packages/database/src/postgres-migrations.ts` to `packages/database/src/migrations.ts`
- Rename: `packages/database/src/postgres-index.test.ts` to `packages/database/src/index.test.ts`
- Modify: `packages/database/src/index.ts` to export the PostgreSQL class as `KaguyaDatabase`
- Modify: `packages/llm/src/index.ts`
- Modify: `packages/llm/src/client.ts` to remove legacy trace types and rename `generateDetailed` to `generate`
- Modify: `packages/llm/src/index.test.ts` to cover the final non-persisting client API only
- Modify: `packages/logger/src/index.ts` and `packages/logger/src/index.test.ts` to remove `traceId`, `eventId`, and `runId` log-context fields
- Delete: `packages/modules/src/events.ts`
- Delete: `packages/modules/src/always-reply-filter.ts`
- Delete: `packages/modules/src/llm-reply.ts`
- Rename: `packages/modules/src/always-reply-information-filter.ts` to `packages/modules/src/always-reply-filter.ts`
- Rename: `packages/modules/src/llm-information-reply.ts` to `packages/modules/src/llm-reply.ts`
- Modify: `packages/modules/src/index.ts` to expose final names only
- Delete: `packages/modules/src/index.test.ts`
- Rename: `packages/modules/src/information-modules.test.ts` to `packages/modules/src/index.test.ts`
- Modify: `packages/runtime/src/runtime.ts` and tests to use the promoted final names
- Delete: `packages/runtime/src/events.ts`
- Delete: `packages/runtime/src/events.test.ts`
- Delete: `packages/runtime/src/dispatch.ts`
- Delete: `packages/runtime/src/dispatch.test.ts`
- Delete: `packages/runtime/src/services.ts`
- Delete: `packages/runtime/src/workflows/message.ts`
- Delete: `packages/runtime/src/workflows.ts`
- Delete: `packages/runtime/src/llm-lifecycle.ts`
- Delete: `packages/runtime/src/llm-lifecycle.test.ts`
- Rename: `packages/runtime/src/information-llm-lifecycle.ts` to `packages/runtime/src/llm-lifecycle.ts`
- Rename: `packages/runtime/src/information-llm-lifecycle.test.ts` to `packages/runtime/src/llm-lifecycle.test.ts`
- Delete: `packages/runtime/src/failure-semantics.test.ts`
- Rename: `packages/runtime/src/information-failure-semantics.test.ts` to `packages/runtime/src/failure-semantics.test.ts`
- Modify: `packages/platform-adapters/src/types.ts`
- Modify: `packages/platform-adapters/src/onebot.ts`
- Modify: `packages/platform-adapters/src/onebot.test.ts`
- Modify: `packages/platform-adapters/src/napcat.ts`
- Modify: `packages/platform-adapters/src/napcat.test.ts`
- Modify: `packages/scheduler/src/index.test.ts`
- Modify: `scripts/workspace-smoke.mjs`
- Modify: `README.md`
- Modify: `docs/developers/architecture.md`
- Modify: `docs/developers/contributing.md`
- Modify: `docs/developers/index.md`
- Modify: `docs/guide/index.md`
- Modify: `docs/guide/installation.md`
- Modify: `docs/reference/environment-variables.md`
- Modify: `docs/reference/index.md`
- Modify: `docs/project/index.md`

**Interfaces:**

- Removes every legacy Core identity and SQLite public symbol.
- Keeps external `platformMessageId` but replaces adapter-created `traceId` with external-source metadata consumed by the Runtime context atom.
- Documents the final public atom contract, Registry startup rule, reserved/custom relation naming, PostgreSQL requirement, and 168-character logging rule.

- [ ] **Step 1: Add a failing forbidden-symbol architecture test**

Create or extend a workspace smoke test that imports every public package entry point and asserts the intended exports compile. Add a source scan limited to production TypeScript files for forbidden legacy API names:

```ts
const forbidden = [
  "EventEnvelope",
  "defineEvent",
  "EventBus",
  "MessageRecord",
  "EventRun",
  "LlmTrace",
  "OutboundMessageRecord",
  "traceId",
  "eventId",
  "runId",
  "databasePath",
  "node:sqlite",
];
```

The source scan is justified here because the public requirement is removal of symbols, not runtime behavior. Exclude historical `docs/ours`, tests, generated `dist`, and the migration design/plan.

- [ ] **Step 2: Run the architecture check and verify RED**

Run: `pnpm exec tsx scripts/workspace-smoke.mjs`

Run: `rg -n "EventEnvelope|defineEvent|EventBus|MessageRecord|EventRun|LlmTrace|OutboundMessageRecord|traceId|eventId|runId|databasePath|node:sqlite" packages apps --glob '*.ts' --glob '!*.test.ts'`

Expected: FAIL/find matches in legacy production files.

- [ ] **Step 3: Delete legacy exports and migrate remaining consumers**

Remove old record schemas and repositories. Promote the staged PostgreSQL, module, and workflow APIs to their final names, then update Runtime imports without compatibility aliases. Scheduler remains payload-generic and no longer imports `EventEnvelope` in tests. Platform adapters stop manufacturing `traceId`; they retain `platformMessageId`, adapter/platform identifiers, source timestamps, normalized content, and raw input for the Runtime ingress boundary.

Run the `rg` command again. Expected: no matches.

- [ ] **Step 4: Update public docs from delivered code**

Read `docs/developers/markdown-features.md` before editing. Update architecture flow diagrams from SQLite/EventBus to PostgreSQL/InformationCore, replace environment variable documentation, explain that logs are projections of committed atoms, and state that old SQLite data is neither read nor migrated. Do not add the internal design page to the public sidebar.

- [ ] **Step 5: Run focused package and documentation checks**

Run: `pnpm vitest run packages/schema packages/sdk packages/engine packages/database packages/logger packages/llm packages/modules packages/platform-adapters packages/runtime apps/server apps/demo`

Run: `pnpm --filter @kaguya/docs docs:check`

Expected: PASS.

- [ ] **Step 6: Commit legacy removal and documentation**

```bash
git add packages apps scripts/workspace-smoke.mjs README.md docs/developers docs/guide docs/reference docs/project pnpm-lock.yaml
git commit -m "refactor(core): remove legacy event and sqlite identities"
```

### Task 12: Run mutation-focused review and final verification

**Files:**

- Modify only files whose tests reveal a concrete defect.

**Interfaces:**

- Verifies the complete approved contract without adding new behavior.

- [ ] **Step 1: Perform the mutation checklist**

For each mutation below, identify the test that fails; add a focused test first if none does:

- remove deep freeze from nested payloads;
- allow a caller-provided ID;
- register a duplicate or post-seal kind;
- skip payload schema parsing;
- accept an undeclared/missing/wrong-kind reference;
- publish before PostgreSQL commit;
- allow atom `UPDATE` or `DELETE`;
- store a terminal state by updating its requested/started atom;
- log 169 code points without truncation;
- expose a prompt, response, credential, database URL, raw body, or header;
- restore `traceId` as a Core lookup key.

- [ ] **Step 2: Run the complete test suite**

Run: `pnpm test`

Expected: PASS with no unhandled rejection or warning.

- [ ] **Step 3: Run all static and build gates**

Run: `pnpm typecheck`

Run: `pnpm lint`

Run: `pnpm format:check`

Run: `pnpm build`

Expected: all commands exit 0.

- [ ] **Step 4: Verify the final tree and diff**

Run:

```bash
rg -n "EventEnvelope|defineEvent|EventBus|MessageRecord|EventRun|LlmTrace|OutboundMessageRecord|traceId|eventId|runId|databasePath|node:sqlite" packages apps --glob '*.ts' --glob '!*.test.ts'
git diff --check
git status --short
```

Expected: `rg` returns no production matches, `git diff --check` prints nothing, and status contains only intentional implementation/documentation changes.

- [ ] **Step 5: Commit any test-proven final corrections**

If Step 1 required a correction, stage only its test and implementation files and commit:

```bash
git commit -m "test(core): close information atom contract gaps"
```

If no correction was required, do not create an empty commit.
