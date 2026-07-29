# Web UI Core Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the local Web UI message endpoint into the existing deterministic Kaguya message workflow and SQLite persistence.

**Architecture:** Add a side-effect-free local ingress factory to `@kaguya/demo`, export it as the demo application's reusable boundary, and inject it from `apps/api/src/server.ts`. The existing `createApiGateway()` app factory remains optional-ingress capable so its `503 core_unavailable` tests keep their meaning.

**Tech Stack:** TypeScript 6 strict ESM, Node.js 24.18.0, pnpm 11.9.0, Vitest 4.1.10, Fastify 5, SQLite through `node:sqlite`, existing `@kaguya/*` workspace packages.

## Global Constraints

- This is a development ingress slice only.
- Do not add persistent queue, inbox/outbox, dead-letter, crash recovery, real platform adapter, real sender, real LLM provider, run query, cancellation API, SSE, management UI, or role model.
- Keep `POST /api/v1/messages` response shape as `{ data: { status: "accepted", requestId } }`.
- The local ingress must return only after workflow dispatch finishes successfully.
- Workflow failures must propagate to the API gateway's existing redacted `500 internal_error` path.
- Startup must fail before `listen()` if the local ingress database cannot initialize.
- Local API database path is configured by `KAGUYA_API_DATABASE_PATH`, defaulting to `.data/kaguya-api.sqlite` at the repository root.
- Use TDD: write each failing test, verify it fails for the expected reason, implement the smallest passing change, then verify green.

---

## File Structure

- Create `apps/demo/src/local-ingress.ts`: reusable local deterministic `MessageIngress`-compatible factory and closeable resource.
- Modify `apps/demo/src/workflows.ts`: re-export `createLocalMessageIngress` and its public types without importing CLI `index.ts`.
- Modify `apps/demo/package.json`: add package `exports` pointing at `dist/workflows.js` and keep `start` on `src/index.ts`.
- Test `apps/demo/src/local-ingress.test.ts`: verifies workflow dispatch and SQLite writes through the local ingress.
- Modify `apps/api/src/config.ts`: add `databasePath` to `ApiGatewayConfig` and parse `KAGUYA_API_DATABASE_PATH`.
- Test `apps/api/src/config.test.ts`: verifies default and override database path behavior.
- Modify `apps/api/package.json` and `apps/api/tsconfig.json`: depend on and reference `@kaguya/demo`.
- Test `apps/api/src/server-composition.test.ts`: verifies API composition with the real local ingress using a temporary database.
- Modify `apps/api/src/server.ts`: create local ingress during startup, pass it to `createApiGateway()`, and close it on shutdown.
- Modify `README.md` and `docs/web-ui.md`: document that local dev now has deterministic core ingress while production gaps remain.

---

### Task 1: Local Demo Message Ingress

**Files:**
- Create: `apps/demo/src/local-ingress.ts`
- Create: `apps/demo/src/local-ingress.test.ts`
- Modify: `apps/demo/src/workflows.ts`
- Modify: `apps/demo/package.json`

**Interfaces:**
- Consumes:
  - `dispatchEvent({ definition, event, eventBus, engine, workflow, context })`
  - `messageReceivedEvent.create(base, { text })`
  - `createMessageWorkflow()`
  - `KaguyaDatabase.open(databasePath)`
- Produces:
  - `export interface LocalMessageIngressCommand { readonly sessionId: string; readonly text: string; readonly requestId: string; }`
  - `export interface LocalMessageIngress { enqueue(command: LocalMessageIngressCommand): Promise<void>; close(): void; }`
  - `export interface CreateLocalMessageIngressOptions { readonly databasePath: string; readonly now?: () => Date; }`
  - `export function createLocalMessageIngress(options: CreateLocalMessageIngressOptions): LocalMessageIngress`

- [ ] **Step 1: Write the failing local ingress test**

Add `apps/demo/src/local-ingress.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalMessageIngress } from "./workflows.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "kaguya-local-ingress-"));
  roots.push(root);
  return join(root, "kaguya.sqlite");
}

describe("local message ingress", () => {
  it("dispatches a Web UI message through the deterministic message workflow", async () => {
    const databasePath = tempDatabasePath();
    const ingress = createLocalMessageIngress({
      databasePath,
      now: () => new Date("2026-07-28T01:02:03.000Z"),
    });

    await ingress.enqueue({
      sessionId: "web-session-1",
      text: "Is the moon bright tonight?",
      requestId: "request-abc",
    });
    ingress.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      const messages = database.messages.listRecent("web-session-1", 10);
      const trace = database.llmTraces.listByTrace("webui-request-abc");
      const runs = database.eventRuns.listByTrace("webui-request-abc");

      expect(messages.map((message) => message.role).sort()).toEqual([
        "assistant",
        "user",
      ]);
      expect(messages.find((message) => message.role === "user")).toMatchObject({
        content: "Is the moon bright tonight?",
        metadata: {
          requestId: "request-abc",
          eventId: "webui-request-abc-message-received",
          traceId: "webui-request-abc",
        },
      });
      expect(messages.find((message) => message.role === "assistant")).toMatchObject({
        content: "It is a lovely night for watching the moon.",
        metadata: {
          generatedBy: "generate-reply",
          traceId: "webui-request-abc",
        },
      });
      expect(trace.map((entry) => entry.kind)).toEqual(["route", "reply"]);
      expect(runs.some((run) => run.nodeId === "persist-message")).toBe(true);
      expect(runs.some((run) => run.nodeId === "persist-reply")).toBe(true);
    } finally {
      database.close();
    }
  });
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm vitest run apps/demo/src/local-ingress.test.ts
```

Expected: FAIL because `createLocalMessageIngress` is not exported from `./workflows.js`.

- [ ] **Step 3: Implement the minimal local ingress**

Create `apps/demo/src/local-ingress.ts`:

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import { EventBus, WorkflowEngine } from "@kaguya/engine";
import { KaguyaLlmClient, createDeterministicModel } from "@kaguya/llm";
import { PromptCompiler } from "@kaguya/prompt";
import type { WorkflowContext } from "@kaguya/sdk";

import { dispatchEvent } from "./dispatch.js";
import { messageReceivedEvent } from "./events.js";
import { LlmLifecycleClient } from "./llm-lifecycle.js";
import type { WorkflowServices } from "./services.js";
import { createMessageWorkflow } from "./workflows/message.js";

export interface LocalMessageIngressCommand {
  readonly sessionId: string;
  readonly text: string;
  readonly requestId: string;
}

export interface LocalMessageIngress {
  enqueue(command: LocalMessageIngressCommand): Promise<void>;
  close(): void;
}

export interface CreateLocalMessageIngressOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
}

export function createLocalMessageIngress(
  options: CreateLocalMessageIngressOptions,
): LocalMessageIngress {
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const database = KaguyaDatabase.open(options.databasePath);
  database.migrate();

  let closed = false;
  let sequence = 0;
  const eventBus = new EventBus();
  const nextId = (prefix: string) =>
    `${prefix}-${String(++sequence).padStart(6, "0")}`;
  const now = options.now ?? (() => new Date());
  const services: WorkflowServices = {
    database,
    promptCompiler: new PromptCompiler(),
    llmClient: new LlmLifecycleClient(
      new KaguyaLlmClient({
        model: createDeterministicModel([
          { shouldReply: true, reason: "the local Web UI message should enter the workflow" },
          { text: "It is a lovely night for watching the moon." },
        ]),
        traceWriter: database.llmTraces,
        now,
        nextId,
      }),
      eventBus,
    ),
    eventBus,
  };
  const engine = new WorkflowEngine({ recorder: database.eventRuns });
  const workflow = createMessageWorkflow();

  return {
    async enqueue(command) {
      if (closed) {
        throw new Error("local message ingress is closed");
      }
      const traceId = `webui-${command.requestId}`;
      const event = messageReceivedEvent.create(
        {
          id: `${traceId}-message-received`,
          source: "webui",
          occurredAt: now().toISOString(),
          traceId,
          sessionId: command.sessionId,
          metadata: { requestId: command.requestId },
        },
        { text: command.text },
      );
      const context: WorkflowContext = {
        traceId,
        sessionId: command.sessionId,
        now,
        nextId,
        services,
      };
      await dispatchEvent({
        definition: messageReceivedEvent,
        event,
        eventBus,
        engine,
        workflow,
        context,
      });
    },
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  };
}
```

Modify `apps/demo/src/workflows.ts`:

```ts
export {
  createLocalMessageIngress,
  type CreateLocalMessageIngressOptions,
  type LocalMessageIngress,
  type LocalMessageIngressCommand,
} from "./local-ingress.js";
```

Modify `apps/demo/package.json`:

```json
"exports": {
  ".": {
    "types": "./dist/workflows.d.ts",
    "default": "./dist/workflows.js"
  }
}
```

- [ ] **Step 4: Run focused test to verify GREEN**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm vitest run apps/demo/src/local-ingress.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run demo package typecheck**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @kaguya/demo typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/demo/src/local-ingress.ts apps/demo/src/local-ingress.test.ts apps/demo/src/workflows.ts apps/demo/package.json
git commit -m "feat(demo): add local message ingress"
```

---

### Task 2: API Database Path Configuration

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/config.test.ts`

**Interfaces:**
- Consumes: existing `readApiGatewayConfig(environment?: NodeJS.ProcessEnv): ApiGatewayConfig`
- Produces:
  - `ApiGatewayConfig.databasePath: string`
  - `KAGUYA_API_DATABASE_PATH` override support

- [ ] **Step 1: Write failing config tests**

Add tests to `apps/api/src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { readApiGatewayConfig } from "./config.js";

const baseEnvironment = {
  KAGUYA_GATEWAY_TOKEN: "test-gateway-token-12345",
};

describe("API gateway configuration", () => {
  it("defaults the local ingress database path under the repository data directory", () => {
    const config = readApiGatewayConfig(baseEnvironment);

    expect(config.databasePath).toMatch(/[/\\]\.data[/\\]kaguya-api\.sqlite$/u);
  });

  it("accepts an explicit local ingress database path", () => {
    const config = readApiGatewayConfig({
      ...baseEnvironment,
      KAGUYA_API_DATABASE_PATH: "/tmp/kaguya-test.sqlite",
    });

    expect(config.databasePath).toBe("/tmp/kaguya-test.sqlite");
  });
});
```

- [ ] **Step 2: Run the focused config test to verify RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm vitest run apps/api/src/config.test.ts
```

Expected: FAIL because `databasePath` does not exist.

- [ ] **Step 3: Implement database path parsing**

Modify `apps/api/src/config.ts`:

```ts
import { fileURLToPath } from "node:url";

const defaultDatabasePath = fileURLToPath(
  new URL("../../../.data/kaguya-api.sqlite", import.meta.url),
);

export interface ApiGatewayConfig {
  host: string;
  port: number;
  gatewayToken: string;
  corsOrigins: readonly string[];
  trustProxy: false | string[];
  rateLimitMax: number;
  rateLimitWindowMs: number;
  databasePath: string;
}
```

Inside `readApiGatewayConfig()` return object:

```ts
databasePath:
  environment.KAGUYA_API_DATABASE_PATH?.trim() || defaultDatabasePath,
```

Update existing `config` fixtures in `apps/api/src/app.test.ts` with:

```ts
databasePath: "/tmp/kaguya-api-test.sqlite",
```

- [ ] **Step 4: Run focused API tests to verify GREEN**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm vitest run apps/api/src/config.test.ts apps/api/src/app.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/api/src/config.ts apps/api/src/config.test.ts apps/api/src/app.test.ts
git commit -m "feat(api): configure local ingress database path"
```

---

### Task 3: API Server Composition With Local Ingress

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/tsconfig.json`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/src/server-composition.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes:
  - `createLocalMessageIngress({ databasePath }): LocalMessageIngress`
  - `createApiGateway({ config, logger, messageIngress })`
- Produces:
  - API dev server injects local deterministic ingress before listening.
  - Server shutdown closes app, ingress, and logger once.

- [ ] **Step 1: Write failing server composition test**

Create `apps/api/src/server-composition.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import { afterEach, describe, expect, it } from "vitest";

import { createApiGateway } from "./app.js";
import type { ApiGatewayConfig } from "./config.js";
import { createConfiguredMessageIngress } from "./server.js";

const gatewayToken = "test-gateway-token-12345";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "kaguya-api-composition-"));
  roots.push(root);
  return join(root, "kaguya.sqlite");
}

function config(databasePath: string): ApiGatewayConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    gatewayToken,
    corsOrigins: ["http://localhost:5173"],
    trustProxy: false,
    rateLimitMax: 30,
    rateLimitWindowMs: 60_000,
    databasePath,
  };
}

describe("API server composition", () => {
  it("injects a local core ingress that persists Web UI messages", async () => {
    const databasePath = tempDatabasePath();
    const ingress = createConfiguredMessageIngress(config(databasePath));
    const app = await createApiGateway({
      config: config(databasePath),
      messageIngress: ingress,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "x-request-id": "request-api-1",
      },
      payload: {
        sessionId: "web-session-api",
        text: "Hello from the browser",
      },
    });

    expect(response.statusCode).toBe(202);
    await app.close();
    ingress.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      const messages = database.messages.listRecent("web-session-api", 10);
      expect(messages.map((message) => message.role).sort()).toEqual([
        "assistant",
        "user",
      ]);
      expect(database.llmTraces.listByTrace("webui-request-api-1")).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
```

- [ ] **Step 2: Run the server composition test to verify RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm vitest run apps/api/src/server-composition.test.ts
```

Expected: FAIL because `createConfiguredMessageIngress` is not exported and `@kaguya/demo` is not an API dependency.

- [ ] **Step 3: Add API dependency and TypeScript reference**

Modify `apps/api/package.json` dependencies:

```json
"@kaguya/demo": "workspace:*"
```

Modify `apps/api/tsconfig.json` references:

```json
{ "path": "../demo" }
```

Modify root `tsconfig.json` references to include web if it is still absent:

```json
{ "path": "./apps/web" }
```

- [ ] **Step 4: Export a testable server composition helper**

Modify `apps/api/src/server.ts` so it exports:

```ts
import { createLocalMessageIngress } from "@kaguya/demo";
import type { LocalMessageIngress } from "@kaguya/demo";

export function createConfiguredMessageIngress(
  config: Pick<ApiGatewayConfig, "databasePath">,
): LocalMessageIngress {
  return createLocalMessageIngress({ databasePath: config.databasePath });
}
```

Then create and pass the ingress in the server bootstrap:

```ts
const messageIngress = createConfiguredMessageIngress(config);
const app = await createApiGateway({
  config,
  logger,
  messageIngress,
});
```

Update `close()`:

```ts
await app.close();
messageIngress.close();
await closeLogger(rootLogger);
```

Keep the existing `SIGINT`, `SIGTERM`, `listen()`, fatal logging, and `process.exitCode` behavior.

- [ ] **Step 5: Run focused server composition test to verify GREEN**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm vitest run apps/api/src/server-composition.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run API and demo typechecks**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @kaguya/api typecheck
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @kaguya/demo typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/api/package.json apps/api/tsconfig.json apps/api/src/server.ts apps/api/src/server-composition.test.ts tsconfig.json pnpm-lock.yaml
git commit -m "feat(api): inject local core ingress"
```

---

### Task 4: Documentation And End-To-End Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/web-ui.md`
- Modify: `docs/remaining-work.md` only if the current boundary text has become inaccurate.

**Interfaces:**
- Consumes: local API server now injects deterministic ingress.
- Produces: docs that explain local messages can be accepted and persisted, while production gaps remain explicit.

- [ ] **Step 1: Write docs update**

Update `docs/web-ui.md` current boundary section to say:

```md
本地开发入口现在会注入确定性的 `MessageIngress`，所以合法消息会返回
`202 accepted` 并写入本地 SQLite。该入口只用于开发闭环验证；它没有持久队列、
真实平台发送、真实模型策略、结果查询或 SSE，因此 UI 仍不会伪造机器人回复。
```

Update `README.md` current boundary text to say:

```md
应用 API 网关在开发启动入口中注入本地确定性 `MessageIngress`，用于验证
Web UI → API → message workflow → SQLite。生产 core dispatcher、持久队列、
consumer、真实模型策略、平台 adapter、持久运行/SSE 和部署仍属于后续工作。
```

- [ ] **Step 2: Run full focused verification**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm vitest run apps/demo/src/local-ingress.test.ts apps/api/src/config.test.ts apps/api/src/app.test.ts apps/api/src/server-composition.test.ts
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @kaguya/api typecheck
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @kaguya/demo typecheck
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm web:build
```

Expected: all commands PASS.

- [ ] **Step 3: Manually verify local dev server**

Run API:

```bash
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" KAGUYA_GATEWAY_TOKEN="local-development-token-2026" pnpm api:dev
```

In another terminal or background session, send:

```bash
curl -sS -i \
  -H 'authorization: Bearer local-development-token-2026' \
  -H 'content-type: application/json' \
  -H 'x-request-id: request-manual-1' \
  --data '{"sessionId":"manual-web-session","text":"Hello Kaguya"}' \
  http://127.0.0.1:3000/api/v1/messages
```

Expected: HTTP `202` with `{"data":{"status":"accepted","requestId":"request-manual-1"}}`.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended documentation changes remain unstaged before the final commit.

- [ ] **Step 5: Commit**

Run:

```bash
git add README.md docs/web-ui.md docs/remaining-work.md
git commit -m "docs: update webui local ingress boundary"
```

---

## Self-Review

Spec coverage:

- Local Web UI message path into core workflow: Task 1 and Task 3.
- Stable event and trace IDs from request ID: Task 1.
- SQLite persistence of messages, event runs, and LLM traces: Task 1 and Task 3 tests.
- API database path config: Task 2.
- Startup composition and shutdown: Task 3.
- Existing app factory optional ingress and `503` behavior: preserved by Task 2 running `app.test.ts`.
- Documentation boundary updates: Task 4.

Placeholder scan:

- No placeholder markers or unspecified test instructions.

Type consistency:

- `LocalMessageIngressCommand`, `LocalMessageIngress`, `CreateLocalMessageIngressOptions`, `createLocalMessageIngress`, and `createConfiguredMessageIngress` are defined before use.
- `ApiGatewayConfig.databasePath` is added in Task 2 before Task 3 consumes it.
