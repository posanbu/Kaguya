# Vanilla Group LLM Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deterministic production server reply behavior with a vanilla OpenAI-compatible LLM path that lets group-chat context decide whether Kaguya should speak and what it should say.

**Architecture:** Keep the existing runtime workflow. Update route/reply prompt policy so Kaguya behaves as a natural group participant, then let `apps/server` inject a real LLM model resolver when `KAGUYA_LLM_API_KEY` and `KAGUYA_LLM_MODEL` are configured. Tests and demo keep the deterministic fallback unless explicit LLM config is provided.

**Tech Stack:** TypeScript, Vitest, Vercel AI SDK, `@ai-sdk/openai-compatible`, existing `@kaguya/runtime` and `@kaguya/llm`.

## Global Constraints

- Do not create a separate bot process; NapCat stays inside `apps/server`.
- Keep Web and platform messages on the shared `@kaguya/runtime`.
- Group context is represented by existing `sessionId=qq:group:<groupId>` message history.
- LLM outputs remain strict JSON matching existing route and reply schemas.
- No complex agent loop, no topic scheduler, no memory redesign in this pass.

---

### Task 1: Group Participant Prompt Policy

**Files:**

- Modify: `packages/runtime/src/workflows/shared.ts`
- Test: `packages/runtime/src/workflows.test.ts`

**Interfaces:**

- Consumes: `routeFragments(conversation)` and reply prompt generation inside the message workflow.
- Produces: route prompts that invite active but non-spammy group participation, and reply prompts that produce concise natural group-chat JSON.

- [ ] **Step 1: Write failing prompt policy tests**
- [ ] **Step 2: Run targeted workflow tests and confirm failure**
- [ ] **Step 3: Update route and reply prompt text**
- [ ] **Step 4: Run targeted workflow tests and confirm pass**

### Task 2: Server LLM Configuration

**Files:**

- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/src/config.test.ts`
- Test: `apps/server/src/server-composition.test.ts`

**Interfaces:**

- Consumes: `KaguyaRuntimeOptions.resolveModel`.
- Produces: `ServerConfig.llm` and a server-created model resolver when `KAGUYA_LLM_API_KEY` and `KAGUYA_LLM_MODEL` are set.

- [ ] **Step 1: Write failing config and composition tests**
- [ ] **Step 2: Run targeted server tests and confirm failure**
- [ ] **Step 3: Parse LLM environment and inject resolver**
- [ ] **Step 4: Run targeted server tests and confirm pass**

### Task 3: Verification

**Files:**

- Existing test suite.

**Interfaces:**

- Produces: verified branch ready for user review.

- [ ] **Step 1: Run `pnpm test`**
- [ ] **Step 2: Run `pnpm typecheck`**
- [ ] **Step 3: Inspect diff**
- [ ] **Step 4: Commit changes**
