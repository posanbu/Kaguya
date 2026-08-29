# Kaguya Init Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable TypeScript/pnpm monorepo that models MaiBot's message, heartbeat, scheduled-memory, Prompt, and LLM paths as traceable event-driven workflows.

**Architecture:** Shared schemas define the contracts; a public SDK defines typed events, listeners, nodes, and workflow graphs; the engine validates and runs those graphs. Prompt, LLM, scheduler, and SQLite packages remain independently replaceable, while the demo application composes them into the three workflows required by meeting item 3.1.

**Tech Stack:** Node.js 24.18.0, pnpm 11.9.0, TypeScript 6.0.3, Vitest 4.1.10, ESLint 10.7.0, Prettier 3.9.6, Zod 4.4.3, Vercel AI SDK 7.0.35, Node `node:sqlite`, promptfoo 0.121.19.

## Global Constraints

- Use TypeScript strict mode and ESM throughout.
- Keep package dependencies acyclic and aligned with the approved design.
- Use injectable clocks and ID factories in every time- or ID-dependent test.
- Do not require an API key, network call, or external database for tests and demo.
- Do not include social-platform adapters, UI, documentation-site code, Computer Use, or plugin compatibility.
- Preserve the user's `origin/main` MIT License initial commit and fold all task commits into one following commit named `chore: initialize Kaguya monorepo`; do not push.

---

## File Map

### Workspace

- `.nvmrc`, `.node-version`: pin Node.js 24.18.0.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`: root tooling and workspace orchestration.
- `tsconfig.base.json`, `tsconfig.json`: strict compiler defaults and project references.
- `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`: repository quality rules.

### Packages

- `packages/schema/src/index.ts`: shared Zod schemas and TypeScript types.
- `packages/sdk/src/index.ts`: typed definition helpers and public workflow contracts.
- `packages/engine/src/event-bus.ts`: intercepting and observing listeners.
- `packages/engine/src/workflow-engine.ts`: graph validation and execution.
- `packages/prompt/src/index.ts`: deterministic Prompt compilation with provenance.
- `packages/llm/src/index.ts`: AI SDK boundary and traced deterministic client.
- `packages/database/src/index.ts`: `node:sqlite` migrations and repositories.
- `packages/scheduler/src/index.ts`: manual, heartbeat, and cron-compatible triggers.

### Demo

- `apps/demo/src/workflows.ts`: message, heartbeat, and scheduled-memory workflow definitions.
- `apps/demo/src/index.ts`: deterministic composition and executable proof.
- `apps/demo/src/workflows.test.ts`: three end-to-end workflow tests.

### Documentation and Prompt Evaluation

- `README.md`: project purpose and quick start.
- `CONTRIBUTING.md`: Node managers, pnpm, build, test, package-development, and commit workflow.
- `docs/maibot-analysis.md`: MaiBot LLM call inventory, Prompt sources, triggers, and Mermaid flow graphs.
- `docs/architecture.md`: Kaguya package and event/workflow design.
- `promptfooconfig.yaml`, `promptfoo/provider.cjs`, `promptfoo/assertions.cjs`: offline Prompt regression suite.

---

### Task 1: Workspace and Empty Package Build Graph

**Files:**

- Create: `.nvmrc`
- Create: `.node-version`
- Create: `.gitignore`
- Create: `.prettierignore`
- Create: `.prettierrc.json`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `packages/{schema,sdk,engine,prompt,llm,database,scheduler}/package.json`
- Create: `packages/{schema,sdk,engine,prompt,llm,database,scheduler}/tsconfig.json`
- Create: `packages/{schema,sdk,engine,prompt,llm,database,scheduler}/src/index.ts`
- Create: `apps/demo/package.json`
- Create: `apps/demo/tsconfig.json`
- Create: `apps/demo/src/index.ts`

**Interfaces:**

- Consumes: none.
- Produces: workspace scripts `build`, `typecheck`, `lint`, `format:check`, `test`, `prompt:test`, and `demo`; package import names `@kaguya/*`.

- [ ] **Step 1: Add a failing workspace smoke test**

Create `scripts/workspace-smoke.mjs`:

```js
import { readFile } from "node:fs/promises";

const root = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expected = ["build", "typecheck", "lint", "test", "prompt:test", "demo"];
for (const script of expected) {
  if (!root.scripts?.[script]) {
    throw new Error(`missing root script: ${script}`);
  }
}
```

- [ ] **Step 2: Run the smoke test and verify it fails**

Run: `node scripts/workspace-smoke.mjs`

Expected: FAIL because the root `package.json` does not exist.

- [ ] **Step 3: Create the root workspace configuration**

Use this root package shape:

```json
{
  "name": "kaguya",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "engines": { "node": "24.18.0", "pnpm": "11.9.0" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "prompt:test": "promptfoo eval --no-cache",
    "demo": "pnpm --filter @kaguya/demo start"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "eslint": "10.7.0",
    "prettier": "3.9.6",
    "promptfoo": "0.121.19",
    "tsx": "4.23.1",
    "typescript": "6.0.3",
    "typescript-eslint": "8.65.0",
    "vitest": "4.1.10"
  }
}
```

Set both version files to `24.18.0`. Configure `pnpm-workspace.yaml` for `apps/*` and `packages/*`. Configure `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `NodeNext`, declaration output, source maps, and `composite`.

Each package must expose `dist/index.js` and `dist/index.d.ts`, set `"type": "module"`, and provide `build` and `typecheck` scripts. Add TypeScript project references matching actual package dependencies. Each initial source entry contains only `export {};` so every composite project has an input file without introducing placeholder behavior.

- [ ] **Step 4: Install dependencies and run workspace checks**

Run:

```bash
pnpm install
node scripts/workspace-smoke.mjs
pnpm build
pnpm typecheck
```

Expected: install succeeds, smoke test exits 0, and TypeScript builds every empty project without errors.

- [ ] **Step 5: Commit the workspace**

```bash
git add .nvmrc .node-version .gitignore .prettierignore .prettierrc.json package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json eslint.config.js scripts packages apps
git commit -m "build: scaffold TypeScript workspace"
```

### Task 2: Shared Schemas and Public SDK

**Files:**

- Create: `packages/schema/src/index.ts`
- Create: `packages/schema/src/index.test.ts`
- Create: `packages/sdk/src/index.ts`
- Create: `packages/sdk/src/index.test.ts`

**Interfaces:**

- Consumes: Zod.
- Produces:
- `EventEnvelope<TType = string, TPayload = unknown>`
  - `MessageRecord`, `MemoryRecord`, `PromptFragment`, `CompiledPrompt`, `LlmTrace`, `EventRun`
  - `defineEvent()`, `defineListener()`, `defineNode()`, `defineWorkflow()`
  - `WorkflowDefinition`, `WorkflowNode`, `WorkflowEdge`, `WorkflowContext`

- [ ] **Step 1: Write failing schema and SDK tests**

Cover exact behavior:

```ts
it("rejects a session event without sessionId", () => {
  expect(() =>
    eventEnvelopeSchema.parse({
      id: "event-1",
      type: "message.received",
      source: "test",
      occurredAt: "2026-07-23T00:00:00.000Z",
      traceId: "trace-1",
      payload: {},
      metadata: {},
    }),
  ).toThrow();
});

it("preserves typed event payloads", () => {
  const messageReceived = defineEvent(
    "message.received",
    z.object({ messageId: z.string() }),
    { sessionScoped: true },
  );
  expect(
    messageReceived.create(baseEvent, { messageId: "m-1" }).payload.messageId,
  ).toBe("m-1");
});

it("rejects duplicate node ids", () => {
  const node = defineNode({ id: "load", run: async (input: string) => input });
  expect(() =>
    defineWorkflow({ id: "duplicate", nodes: [node, node], edges: [] }),
  ).toThrow("duplicate node id: load");
});
```

- [ ] **Step 2: Run tests and verify missing exports**

Run: `pnpm vitest run packages/schema packages/sdk`

Expected: FAIL because the package source exports do not exist.

- [ ] **Step 3: Implement shared schemas**

Use discriminated record types and runtime Zod validation. The required event validation must be explicit:

```ts
export const eventEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    source: z.string().min(1),
    occurredAt: z.iso.datetime(),
    traceId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    payload: z.unknown(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .superRefine((event, context) => {
    const globalTypes = new Set(["memory.schedule.tick"]);
    if (!globalTypes.has(event.type) && event.sessionId === undefined) {
      context.addIssue({
        code: "custom",
        message: `${event.type} requires sessionId`,
      });
    }
  });
```

Define the Prompt fragment source union exactly as:

```ts
export type PromptFragmentSource =
  "template" | "history" | "memory" | "persona" | "policy" | "state";
```

- [ ] **Step 4: Implement SDK helpers**

`defineEvent` returns a typed object with `type`, `payloadSchema`, `sessionScoped`, and `create`. `defineNode` returns a node with one focused async `run` method. `defineWorkflow` validates duplicate IDs, missing edge endpoints, and cycles using depth-first traversal.

Core signatures:

```ts
export interface WorkflowContext {
  traceId: string;
  sessionId?: string;
  now(): Date;
  nextId(prefix: string): string;
  services: Record<string, unknown>;
}

export interface WorkflowNode<TInput = unknown, TOutput = unknown> {
  id: string;
  run(input: TInput, context: WorkflowContext): Promise<TOutput>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  when?: (output: unknown) => boolean;
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm vitest run packages/schema packages/sdk
pnpm typecheck
```

Expected: all schema and SDK tests pass; typecheck exits 0.

Commit:

```bash
git add packages/schema packages/sdk
git commit -m "feat: add workflow schemas and SDK"
```

### Task 3: Event Bus and Workflow Engine

**Files:**

- Create: `packages/engine/src/event-bus.ts`
- Create: `packages/engine/src/event-bus.test.ts`
- Create: `packages/engine/src/workflow-engine.ts`
- Create: `packages/engine/src/workflow-engine.test.ts`
- Create: `packages/engine/src/index.ts`

**Interfaces:**

- Consumes: schema records and SDK workflow definitions.
- Produces:
  - `EventBus.subscribe()`, `EventBus.emit()`
  - `WorkflowEngine.run()`
  - `WorkflowRunRecorder`

- [ ] **Step 1: Write failing event bus tests**

Tests must prove priority, mutation, interruption, and observation isolation:

```ts
it("runs interceptors by descending priority and stops on interruption", async () => {
  const order: string[] = [];
  bus.subscribe(
    "message.received",
    async (event) => {
      order.push("low");
      return { continue: true, event };
    },
    { name: "low", priority: 0, mode: "intercept" },
  );
  bus.subscribe(
    "message.received",
    async (event) => {
      order.push("high");
      return { continue: false, event };
    },
    { name: "high", priority: 10, mode: "intercept" },
  );

  const result = await bus.emit(messageEvent);
  expect(order).toEqual(["high"]);
  expect(result.continue).toBe(false);
});
```

Add an observer that throws and assert the emitted business result remains successful while `onObserverError` receives the error.

- [ ] **Step 2: Write failing workflow engine tests**

Use a two-node graph and assert:

- output flows from the first node to the second;
- a false `when` edge is skipped;
- recorder receives `running` then `completed`;
- a thrown node records `failed`, node ID, error class, and retryability.

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm vitest run packages/engine`

Expected: FAIL because `EventBus` and `WorkflowEngine` do not exist.

- [ ] **Step 4: Implement the event bus**

Use this result contract:

```ts
export interface InterceptResult<TEvent extends EventEnvelope = EventEnvelope> {
  continue: boolean;
  event: TEvent;
}
```

Interceptors run sequentially. Observers run with `Promise.allSettled` after successful interceptors. Clone only the top-level event and metadata/payload records so listeners cannot mutate the caller's event in place.

- [ ] **Step 5: Implement workflow execution and recording**

Use an adjacency map and a queue of `{ nodeId, input }`. A node may activate multiple outgoing edges. Reject ambiguous disconnected entry nodes unless `startNodeId` is explicit.

Recorder contract:

```ts
export interface WorkflowRunRecorder {
  record(run: EventRun): Promise<void>;
}
```

Record each node before and after execution. Classify `AbortError` as cancelled, `RetryableError` as retryable, and all other errors as non-retryable.

- [ ] **Step 6: Run checks and commit**

Run:

```bash
pnpm vitest run packages/engine
pnpm typecheck
pnpm lint
```

Expected: engine tests pass and static checks exit 0.

Commit:

```bash
git add packages/engine
git commit -m "feat: add event bus and workflow engine"
```

### Task 4: Prompt Compiler and Traced LLM Boundary

**Files:**

- Create: `packages/prompt/src/index.ts`
- Create: `packages/prompt/src/index.test.ts`
- Create: `packages/llm/src/index.ts`
- Create: `packages/llm/src/index.test.ts`

**Interfaces:**

- Consumes: schema types and AI SDK Core.
- Produces:
  - `PromptCompiler.compile(kind, fragments)`
  - `KaguyaLlmClient.generate(request)`
  - `createDeterministicModel(outputs)`
  - `LlmTraceWriter`

- [ ] **Step 1: Write failing Prompt tests**

```ts
it("sorts fragments by priority and then original position", () => {
  const compiled = compiler.compile("route", [
    fragment("history", 20, "history"),
    fragment("persona", 10, "persona"),
    fragment("memory", 20, "memory"),
  ]);
  expect(compiled.fragments.map((item) => item.content)).toEqual([
    "persona",
    "history",
    "memory",
  ]);
  expect(compiled.text).toContain("<persona>");
  expect(compiled.text).toContain("<history>");
});

it("keeps route-only policy out of reply prompts", () => {
  expect(() =>
    compiler.compile("reply", [
      fragment("policy", 1, "route-only", { scope: "route" }),
    ]),
  ).toThrow("fragment is not valid for reply prompt");
});
```

- [ ] **Step 2: Write failing LLM trace tests**

Use AI SDK's `MockLanguageModelV3`. Assert a successful generation writes a completed trace with usage and that a provider error writes a failed trace before rethrowing a normalized error.

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm vitest run packages/prompt packages/llm`

Expected: FAIL because compiler and client exports do not exist.

- [ ] **Step 4: Implement deterministic Prompt compilation**

Compile fragments into tagged blocks:

```text
<persona source="persona-id">
...
</persona>
```

Return `kind`, `text`, the sorted complete fragments, and `provenance` containing fragment ID, source, priority, and SHA-256 content digest.

- [ ] **Step 5: Implement the AI SDK wrapper**

Required request:

```ts
export interface KaguyaLlmRequest {
  kind: "route" | "reply" | "state" | "memory";
  modelId: string;
  prompt: CompiledPrompt;
  traceId: string;
  workflowId: string;
  nodeId: string;
}
```

Call `generateText({ model, prompt: request.prompt.text })`. Parse deterministic JSON outputs by request kind and reject invalid JSON as a non-retryable response error. Always write the trace in `finally`, including timestamps, duration, normalized usage, response, or error.

- [ ] **Step 6: Run checks and commit**

Run:

```bash
pnpm vitest run packages/prompt packages/llm
pnpm typecheck
pnpm lint
```

Expected: tests and static checks pass.

Commit:

```bash
git add packages/prompt packages/llm
git commit -m "feat: add prompt provenance and LLM tracing"
```

### Task 5: SQLite Repositories

**Files:**

- Create: `packages/database/src/migrations.ts`
- Create: `packages/database/src/repositories.ts`
- Create: `packages/database/src/index.ts`
- Create: `packages/database/src/index.test.ts`

**Interfaces:**

- Consumes: schema records and `node:sqlite`.
- Produces:
  - `KaguyaDatabase`
  - `MessageRepository`
  - `MemoryRepository`
  - `EventRunRepository`
  - `LlmTraceRepository`

- [ ] **Step 1: Write failing repository tests**

Open `:memory:`, migrate, insert two session messages, and assert `listRecent(sessionId, 1)` returns only the latest. Insert memory and assert time-window queries. Record event runs and LLM traces and verify JSON columns round-trip without losing provenance.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run packages/database`

Expected: FAIL because database exports do not exist.

- [ ] **Step 3: Implement migrations**

Create `schema_migrations`, `messages`, `memories`, `event_runs`, and `llm_traces`. Use text UUIDs, ISO timestamps, checked enum text columns, JSON stored as text, and indexes on:

- `(session_id, occurred_at)` for messages and memories;
- `(trace_id, started_at)` for event runs;
- `(trace_id, started_at)` for LLM traces.

Run migrations inside a transaction and record each migration version exactly once.

- [ ] **Step 4: Implement repositories**

All dynamic values must use prepared statements. JSON parsing failures must throw a `DatabaseRecordError` containing table and record ID. Repository public methods return schema types, not SQLite row objects.

Database lifecycle:

```ts
const database = KaguyaDatabase.open(":memory:");
database.migrate();
database.messages.insert(message);
database.close();
```

- [ ] **Step 5: Run checks and commit**

Run:

```bash
pnpm vitest run packages/database
pnpm typecheck
pnpm lint
```

Expected: repository tests and static checks pass.

Commit:

```bash
git add packages/database
git commit -m "feat: add SQLite persistence"
```

### Task 6: Scheduler, Three Workflows, and Demo

**Files:**

- Create: `packages/scheduler/src/index.ts`
- Create: `packages/scheduler/src/index.test.ts`
- Create: `apps/demo/src/services.ts`
- Create: `apps/demo/src/workflows.ts`
- Create: `apps/demo/src/workflows.test.ts`
- Create: `apps/demo/src/index.ts`

**Interfaces:**

- Consumes: all packages.
- Produces:
  - `ManualTrigger`
  - `IntervalTrigger`
  - `CronTrigger`
  - `createMessageWorkflow()`
  - `createHeartbeatWorkflow()`
  - `createMemoryWorkflow()`
  - `pnpm demo`

- [ ] **Step 1: Write failing scheduler tests**

With fake timers, assert interval trigger emits twice, then stops after cancellation. Assert manual trigger preserves the supplied trace and session IDs. Cron trigger must expose its configured expression without waiting in tests.

- [ ] **Step 2: Write failing workflow integration tests**

Test three scenarios:

1. `message.received` persists the user message, compiles route and reply Prompts, records two LLM traces, and persists the generated reply.
2. `heartbeat.tick` compiles state and route Prompts, persists state memories, and skips reply when route returns false.
3. `memory.schedule.tick` reads only the requested time window, compiles memory policy, and persists extracted long-term memories.

Assert every resulting database row uses the originating `traceId`.

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm vitest run packages/scheduler apps/demo`

Expected: FAIL because triggers and workflows do not exist.

- [ ] **Step 4: Implement scheduler triggers**

All triggers expose:

```ts
export interface Trigger<TPayload> {
  start(handler: (payload: TPayload) => Promise<void>): () => void;
}
```

`ManualTrigger.fire()` invokes the handler immediately. `IntervalTrigger` uses an injected timer API. `CronTrigger` accepts a six-field expression and injected next-run calculator; invalid expressions fail during construction.

- [ ] **Step 5: Implement workflow service composition**

Create typed service accessors for database, Prompt compiler, LLM client, and event bus. Define focused nodes such as `persist-message`, `load-context`, `compile-route`, `decide-route`, `compile-reply`, `generate-reply`, `update-state`, and `write-memory`.

Use conditional edges:

```ts
{
  from: "decide-route",
  to: "compile-reply",
  when: (result) => routeDecisionSchema.parse(result).shouldReply,
}
```

The global scheduled-memory event expands into one workflow run per target session while preserving the parent trace in metadata.

- [ ] **Step 6: Implement deterministic demo**

Use an on-disk file under `.data/kaguya-demo.sqlite`, recreate only demo records through repository methods, run all three workflows, and print a compact summary:

```text
message workflow: completed
heartbeat workflow: completed
memory workflow: completed
messages: <count>
memories: <count>
llm traces: <count>
```

- [ ] **Step 7: Run checks and commit**

Run:

```bash
pnpm vitest run packages/scheduler apps/demo
pnpm demo
pnpm typecheck
pnpm lint
```

Expected: all tests pass; demo completes all three workflows without network access.

Commit:

```bash
git add packages/scheduler apps/demo
git commit -m "feat: run message heartbeat and memory workflows"
```

### Task 7: MaiBot Analysis, Architecture, Contributing Guide, and Promptfoo

**Files:**

- Create: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `docs/maibot-analysis.md`
- Create: `docs/architecture.md`
- Create: `promptfooconfig.yaml`
- Create: `promptfoo/provider.cjs`
- Create: `promptfoo/assertions.cjs`
- Modify: `docs/superpowers/specs/2026-07-23-kaguya-init-design.md`
- Include: `docs/meeting-0722.md`

**Interfaces:**

- Consumes: implemented public APIs and inspected MaiBot source.
- Produces: contributor build instructions, research traceability, architecture documentation, offline Prompt regression tests.

- [ ] **Step 1: Add failing Promptfoo cases**

Define four cases using an offline custom provider:

- route includes history, persona, memory, and route policy;
- reply excludes route-only policy;
- state includes short-term state policy;
- memory includes only records inside the requested window and memory policy.

Each assertion module must inspect the rendered Prompt and return `{ pass, score, reason }`.

- [ ] **Step 2: Run Promptfoo to verify failure**

Run: `pnpm prompt:test`

Expected: FAIL until provider and assertions are connected to the implemented Prompt compiler.

- [ ] **Step 3: Write MaiBot analysis**

Inventory all direct LLM call categories found under:

- `src/maisaka`
- `src/chat/replyer`
- `src/chat/image_system`
- `src/emoji_system`
- `src/learners`
- `src/services`
- `src/A_memorix`
- `src/mcp_module`
- relevant WebUI diagnostic endpoints

For each category document trigger, Prompt sources, model call, output consumer, and persistence effect. Distinguish active event/hook paths from commented or legacy paths. Include Mermaid diagrams for inbound messages, short-interval runtime wakeups, and long-interval learning/memory jobs.

- [ ] **Step 4: Write project documentation**

`CONTRIBUTING.md` must contain:

- nvm and fnm setup using the checked-in version files;
- Corepack/pnpm 11.9.0 setup;
- install, build, typecheck, lint, test, Promptfoo, and demo commands;
- how to add a package and TypeScript reference;
- TDD workflow and regression-test expectation;
- package dependency rules;
- SQLite migration rules;
- documentation expectations and pre-commit checklist.

`docs/architecture.md` must map each package to the meeting 3.1 concern it addresses and explain the event fields, node/edge model, three workflows, Prompt provenance, LLM trace, and database schema.

- [ ] **Step 5: Make Promptfoo pass**

Connect the offline provider to `@kaguya/prompt`, return compiled Prompt text as provider output, and implement exact structural assertions. Do not invoke a remote model.

Run:

```bash
pnpm prompt:test
pnpm format
pnpm format:check
pnpm lint
```

Expected: four Promptfoo cases pass and format/lint exit 0.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md CONTRIBUTING.md docs promptfooconfig.yaml promptfoo
git commit -m "docs: document MaiBot analysis and contributor workflow"
```

### Task 8: Full Verification and Single Kaguya Init Commit

**Files:**

- Verify: entire repository.
- Modify only files required by verification failures.

**Interfaces:**

- Consumes: all previous deliverables.
- Produces: clean, verified local repository with the user's MIT License initial commit followed by one Kaguya init commit.

- [ ] **Step 1: Run the full clean verification**

Run:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm prompt:test
pnpm demo
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Inspect generated and ignored files**

Run:

```bash
git status --short
git check-ignore -v .data/kaguya-demo.sqlite packages/schema/dist/index.js
```

Expected: no unexpected tracked changes; demo database and build output are ignored.

- [ ] **Step 3: Review requirement coverage**

Confirm:

- monorepo and TypeScript build;
- nvm/fnm and pnpm pinning;
- MaiBot-based package classification;
- event fields and triggers;
- message, heartbeat, and scheduled-memory graphs;
- Prompt provenance and all LLM traces;
- SQLite repositories;
- promptfoo tests;
- `CONTRIBUTING.md`;
- existing `origin/main` preserved, with no push performed by Codex.

- [ ] **Step 4: Fold temporary commits onto the user's initial commit**

Preserve the user's `origin/main` initial commit and its MIT License, while replacing only this task's local temporary history:

```bash
git reset origin/main
git add --all
git commit -m "chore: initialize Kaguya monorepo"
```

The mixed reset restores the remote initial commit's index entry for `LICENSE`; staging then adds the complete Kaguya tree without accidentally staging a License deletion. Expected: `git log --oneline` contains the user's `Initial commit`, followed by exactly one `chore: initialize Kaguya monorepo` commit.

- [ ] **Step 5: Re-run final evidence checks**

Run:

```bash
git status --short --branch
git log --oneline --decorate
pnpm test
pnpm prompt:test
pnpm demo
```

Expected: clean `main`, the preserved initial License commit plus one Kaguya init commit, and all three commands pass.
