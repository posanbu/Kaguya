# Model Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 reply-only LLM lifecycle 迁移为受 #76 capability 权限控制、使用 #79 幂等与唯一终态、支持任意账本 source 的结构化 Model Task，并用 person-fact 垂直切片验证非 reply 调用。

**Architecture:** `@kaguya/llm` 只提供无密钥、单次调用的 provider 边界；`@kaguya/runtime` 实现 Model Task capability，负责输入重载、provenance、policy、输出 schema 和审计 lifecycle；`@kaguya/modules` 通过 `context.use(modelTaskCapability)` 调用它。requested 使用 #79 的 `registerOnce`，completed/failed/cancelled 使用 `commitTerminal`，业务模块只消费已提交且已校验的赢家。

**Tech Stack:** TypeScript 6、Zod 4、Vercel AI SDK、PostgreSQL/PGlite、Vitest、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-06-model-task-design.md`

## Global Constraints

- #76 的 `defineModuleCapability<T>(id, apiVersion)`、`context.use(token)`、activation provenance 是唯一模块能力入口；不得复制或修改 #76→#79 session 的 SDK/Host 实现。
- #79 的 `registerOnce(operation, key, definition, input, guard?)` 返回实际赢家；`commitTerminal(group, subjectInformationId, definition, input, guard?)` 原子返回实际赢家；不得使用“查询后普通 register”实现去重或终态。
- `core.withClaim(claim, signal, run)` 与 `core.executionSignal` 负责 claim fencing；shutdown/lease expiry 不能写业务 cancelled，迟到写入必须被 fencing 拒绝。
- provider 边界不做隐式 retry；有界 retry 只属于 #79 durable runner，不向调用方承诺 provider side effect exactly-once。
- 不保留旧 reply-only executor、固定 `kind: "reply"` lifecycle、生产兼容 adapter 或双写路径。
- 新建或修改的源码文件必须维护中文架构头注释；每个行为变更先写失败测试并观察 RED，再写最小实现。
- Prompt、输出正文、凭据和 provider 原始错误不得进入日志、metrics 或 inspection；公开错误只使用脱敏类型和通用消息。

## File Map

- `packages/llm/src/client.ts`、`packages/llm/src/client.test.ts`：单次 provider 请求、AbortSignal、task-owned output schema、usage/duration 和错误分类。
- `packages/runtime/src/model-task.ts`、`packages/runtime/src/model-task.test.ts`：Model Task capability 实现、稳定 fingerprint、账本重载、requested/terminal 组装和赢家返回。
- `packages/runtime/src/information-kinds.ts`、`packages/runtime/src/index.ts`：通用 `core.model.task.*` lifecycle definitions 与安全审计投影，移除旧 reply-only lifecycle 导出。
- `packages/runtime/src/runtime.ts`、`packages/runtime/src/runtime.test.ts`：宿主批准 model tier/policy、activation provenance 和 capability value 的组合；reply 使用新 capability。
- `packages/modules/src/llm-reply.ts`、`packages/modules/src/information-modules.test.ts`：reply module 从 executor 注入迁移到 typed capability，保留 prompt/context 与 assistant/delivery 业务写入。
- `packages/modules/src/person-fact-task.ts`、`packages/modules/src/person-fact-task.test.ts`、`packages/modules/src/index.ts`：最小结构化 person-fact task 与 domain output schema，使用非 reply source。
- `packages/runtime/src/model-task-persistence.test.ts`：真实 `KaguyaDatabase` 测试，覆盖持久化窗口、重投、并发和日志脱敏；不修改 #79 repository 实现。

### Task 1: Generalize the provider boundary

**Files:**
- Modify: `packages/llm/src/client.ts`
- Modify: `packages/llm/src/index.ts`
- Modify: `packages/llm/src/index.test.ts`
- Create: `packages/llm/src/client.test.ts` if the existing test file cannot isolate the new contract

**Interfaces:**
- Consumes: `CompiledPrompt` and a host-resolved `LanguageModel`.
- Produces: `KaguyaLlmClient.generate<TOutput>({ modelId, prompt, outputSchema, signal }) -> Promise<KaguyaLlmGeneration<TOutput>>`; no `kind` union, no provider secret, and no retry option.

- [ ] **Step 1: Write the failing tests** for passing `AbortSignal` to `generateText`, using a task-supplied Zod output schema, rejecting schema-invalid provider output, normalizing usage/duration, and preserving only a classified error kind.
- [ ] **Step 2: Run the focused tests** with `pnpm exec vitest run packages/llm/src/client.test.ts -v`; verify the failure is caused by the missing generic request/schema/signal contract.
- [ ] **Step 3: Implement the smallest provider change**: replace `kind` lookup with `outputSchema`, pass `abortSignal: request.signal`, set the AI SDK retry count to zero, and keep raw causes private to the thrown `KaguyaLlmError`.
- [ ] **Step 4: Run the focused tests** and then `pnpm exec vitest run packages/llm/src/index.test.ts packages/llm/src/client.test.ts -v`; verify all provider tests pass.
- [ ] **Step 5: Commit** with `git add packages/llm/src && git commit -m "feat: generalize model provider boundary"`.

### Task 2: Implement the generic Model Task lifecycle

**Files:**
- Create: `packages/runtime/src/model-task.ts`
- Create: `packages/runtime/src/model-task.test.ts`
- Modify: `packages/runtime/src/information-kinds.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes: #76 `ModuleCapability` token/value shape, #79 `InformationCore.registerOnce`, `InformationCore.commitTerminal`, `InformationCore.withClaim`, `InformationCore.executionSignal`, `InformationCore.getMany`, and `KaguyaLlmClient.generate<TOutput>` from Task 1.
- Produces: `modelTaskCapability`, `ModelTaskCapability`, `ModelTaskRequest<TOutput>`, `ModelTaskResult<TOutput>`, `ModelTaskCancellation`, and `ModelTaskClient` for Runtime composition and module tests.

- [ ] **Step 1: Write failing tests** for a generic reply-shaped task and a non-reply person-fact-shaped task: same task/source/prompt/policy must reuse requested identity; provenance mismatch and disallowed tier must fail before provider; output schema failure must create failed terminal without exposing output; completed/failed/cancelled must compete in one terminal group; concurrent loser returns the winner.
- [ ] **Step 2: Run `pnpm exec vitest run packages/runtime/src/model-task.test.ts -v`** and verify the tests fail because the capability and generic lifecycle definitions do not exist.
- [ ] **Step 3: Add the generic lifecycle definitions** `core.model.task.requested`, `core.model.task.completed`, `core.model.task.failed`, `core.model.task.cancelled`; payload schemas must persist task/version, prompt provenance, source/context references, resolved model, activation provenance, selection policy, usage/duration, and only safe error fields. Do not create a reply/memory/person union.
- [ ] **Step 4: Implement fingerprinting** with canonical JSON for task/version, source ID, prompt kind, ordered provenance entries including contentDigest, and selection policy; exclude module instance ID and prompt/output from the dedupe key.
- [ ] **Step 5: Implement execute** in this order: validate task/schema/policy; reload `contextAtoms` by ID and compare order/provenance; call `registerOnce`; read an existing terminal; call provider once with the active signal; parse output with the task schema; call `commitTerminal` for completed or safe failed/cancelled; return the terminal winner only.
- [ ] **Step 6: Implement explicit cancellation** so only `cancel({ requestedInformationId, reason })` can commit cancelled; provider AbortError caused by shutdown/lease is not business cancelled, and late completion is guarded by #79.
- [ ] **Step 7: Run focused tests** and inspect persisted atoms to confirm no provider call occurs for preflight rejection and no unvalidated output is returned.
- [ ] **Step 8: Commit** with `git add packages/runtime/src/model-task.ts packages/runtime/src/model-task.test.ts packages/runtime/src/information-kinds.ts packages/runtime/src/index.ts && git commit -m "feat: add generic model task lifecycle"`.

### Task 3: Wire the capability into Runtime and migrate reply

**Files:**
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/src/runtime.test.ts`
- Modify: `packages/modules/src/llm-reply.ts`
- Modify: `packages/modules/src/information-modules.test.ts`
- Modify: `packages/modules/src/index.ts`

**Interfaces:**
- Consumes: `modelTaskCapability` and `ModelTaskClient` from Task 2; #76 `context.use` and activation provenance.
- Produces: Runtime composition that supplies only the host-approved capability; reply module calls the generic capability and receives only a validated terminal result.

- [ ] **Step 1: Write failing integration tests** proving reply obtains capability through `context.use`, does not receive a raw provider/client, uses `taskId: "core.reply.generate"` and a versioned output schema, and still produces assistant/delivery only after a completed winner.
- [ ] **Step 2: Run the focused integration tests** and verify they fail because reply still depends on `LlmReplyExecutor` and old `core.llm.*` kinds.
- [ ] **Step 3: Replace the injected executor** with the capability token lookup; use the selected reply atom as `sourceInformationId`, pass reloaded context atoms and compiled Prompt, and map only a completed `ModelTaskResult` into the existing assistant business atom.
- [ ] **Step 4: Wire the Runtime capability value** with resolved model tier/policy and activation provenance; keep provider/model handles private to Runtime and remove old `LlmLifecycleClient` construction from the reply path.
- [ ] **Step 5: Run `pnpm exec vitest run packages/modules/src/information-modules.test.ts packages/runtime/src/runtime.test.ts -v`** and verify reply tests cover failures, duplicate delivery and terminal-winner semantics.
- [ ] **Step 6: Commit** with `git add packages/runtime/src packages/modules/src && git commit -m "refactor: migrate reply to model task capability"`.

### Task 4: Add the structured person-fact vertical slice

**Files:**
- Create: `packages/modules/src/person-fact-task.ts`
- Create: `packages/modules/src/person-fact-task.test.ts`
- Modify: `packages/modules/src/information-kinds.ts`
- Modify: `packages/modules/src/index.ts`

**Interfaces:**
- Consumes: `modelTaskCapability` through #76 `context.use`; a non-reply `core.person.fact.candidate` source atom.
- Produces: a strict `personFactOutputSchema` and a module that invokes the same capability with `taskId: "core.person.fact.extract"`, `taskVersion: 1`, and registers a domain `core.person.fact.extracted` atom only after validated completion.

- [ ] **Step 1: Write failing tests** for a candidate source that is not `core.reply.requested`, a structured output with person/name/fact fields, invalid output rejection, and domain registration only after Model Task completion.
- [ ] **Step 2: Run `pnpm exec vitest run packages/modules/src/person-fact-task.test.ts -v`** and verify the task module and kinds are absent.
- [ ] **Step 3: Define strict candidate/output/domain schemas**; output payload must be owned by the task and the domain atom by the module, preserving the separation between structure validation and truth/business validation.
- [ ] **Step 4: Implement the module** with explicit selector/context and `context.use(modelTaskCapability)`; assert the source ID is the non-reply candidate and never assume inbound/reply kind.
- [ ] **Step 5: Run focused module tests** and verify the provider sees the candidate source and the business caller sees only parsed output.
- [ ] **Step 6: Commit** with `git add packages/modules/src && git commit -m "feat: add person fact model task example"`.

### Task 5: Add real-persistence crash-window and audit verification

**Files:**
- Create: `packages/runtime/src/model-task-persistence.test.ts`
- Modify: `packages/runtime/src/llm-lifecycle.test.ts` only to remove obsolete reply-only lifecycle coverage after the new tests replace it
- Modify: `packages/runtime/src/runtime.test.ts` for restart/recovery assertions if the #79 runner exposes the required fixture

**Interfaces:**
- Consumes: `createTestingDatabase`, the real `InformationRepository`, #79 durable runner/claim APIs, and Task 2’s Model Task capability.
- Produces: executable evidence for requested/provider/terminal/ack crash windows and explicit documentation of any unavailable production PostgreSQL run.

- [ ] **Step 1: Write failing persistence tests** that interrupt execution after requested, after provider return, and after terminal commit before ack; assert restart reuses the requested slot, only one terminal wins, and a shutdown-aborted handler remains recoverable.
- [ ] **Step 2: Run the tests** against PGlite and verify each failure is in the missing crash-window harness or missing Model Task integration, not in a fixture-only fake.
- [ ] **Step 3: Implement only the Model Task test harness/adapters**; do not patch #79 repository behavior from this worktree. Use explicit barriers to place the process-window failures and real durable tables for assertions.
- [ ] **Step 4: Add audit redaction assertions** over atom log projection, runtime logger, metrics and inspection output; assert absence of prompt text, output body, credential strings, database URL and raw provider error.
- [ ] **Step 5: Run focused persistence tests** and, when PostgreSQL is configured, `pnpm test:postgres`; report skipped production coverage rather than treating PGlite as equivalent.
- [ ] **Step 6: Commit** with `git add packages/runtime/src && git commit -m "test: verify model task persistence windows"`.

### Task 6: Final verification and handoff

**Files:**
- Modify: affected source headers, package barrels, and developer documentation only where the final public contract changed.

- [ ] **Step 1: Run `pnpm typecheck`** and fix only errors caused by the new contract or the coordinated #76→#79 merge.
- [ ] **Step 2: Run `pnpm test`** and verify the full suite is green after building workspace packages as required by the repository.
- [ ] **Step 3: Run `pnpm lint` and `pnpm format:check`**; correct formatting/lint issues without changing semantics.
- [ ] **Step 4: Re-read the spec and inspect `git diff origin/main...HEAD`** for old executor imports, `kind: "reply"` lifecycle paths, normal terminal writes, unredacted logs, or compatibility adapters.
- [ ] **Step 5: Record exact test counts, skipped PostgreSQL status, changed files and remaining limitations in the final handoff**; do not claim crash recovery unless the real persistence test ran.
