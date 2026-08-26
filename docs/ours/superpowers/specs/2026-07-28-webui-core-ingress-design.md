# Web UI Core Ingress Design

## Goal

Make the local Web UI message form exercise the existing Kaguya core workflow
instead of stopping at `503 core_unavailable`. This is a development ingress
slice: it should prove `apps/web -> apps/api -> message workflow -> SQLite`
without claiming production queue, platform adapter, streaming response, or real
model readiness.

## Current State

`apps/api` already exposes `POST /api/v1/messages`, validates
`sessionId/text`, authenticates with a Bearer token, and hands the normalized
command to an optional `MessageIngress`. When no ingress is configured,
`server.ts` returns `503 core_unavailable`.

`apps/demo` already owns the deterministic message workflow composition, but the
composition is embedded in the CLI entrypoint. The API should not import or run
that CLI main function. The reusable part needs a small application boundary.

## Scope

Implement a local development `MessageIngress` that:

- receives `{ sessionId, text, requestId }` from `apps/api`;
- creates a valid `message.received` event with stable Kaguya IDs;
- dispatches `createMessageWorkflow()` through `EventBus` and `WorkflowEngine`;
- writes messages, event runs, and deterministic LLM traces to the configured
  local SQLite database;
- returns only after the workflow dispatch finishes successfully.

The Web UI response remains the current `202 accepted` shape. The UI will not
display a bot reply in this slice because there is still no run query or SSE
contract.

## Non-Goals

- No persistent queue, inbox/outbox, dead-letter, or crash recovery.
- No real chat platform webhook or sender.
- No real LLM provider or provider fallback.
- No run status API, cancellation API, or SSE.
- No management UI or role model.
- No production deployment claim.

## Architecture

Add a reusable local core module under the demo/application side, then inject it
from the API server.

The reusable module should expose a factory similar to:

```ts
createLocalMessageIngress(options): MessageIngress & AsyncDisposable-like close
```

It owns:

- `KaguyaDatabase.open(databasePath)` and `migrate()`;
- one `EventBus`;
- one `WorkflowEngine` using `database.eventRuns`;
- `PromptCompiler`;
- deterministic `KaguyaLlmClient` wrapped by `LlmLifecycleClient`;
- `createMessageWorkflow()`.

`apps/api/src/server.ts` reads a local database path from configuration and
injects this ingress into `createApiGateway()`. If the ingress cannot initialize,
startup fails before listening.

## Configuration

Add an API configuration value:

- `KAGUYA_API_DATABASE_PATH`, defaulting to `.data/kaguya-api.sqlite` from the
  repository root.

The token and CORS behavior stay unchanged. There is no environment toggle for
"enable ingress"; the development server should always configure the local
ingress for this slice.

## Data Flow

1. Browser submits `sessionId` and `text` to `POST /api/v1/messages`.
2. API validates and authenticates the request.
3. API calls `messageIngress.enqueue({ sessionId, text, requestId })`.
4. Local ingress creates:
   - event ID derived from `requestId`;
   - trace ID derived from `requestId`;
   - source `webui`;
   - metadata containing `{ requestId }`.
5. Local ingress dispatches the existing message workflow.
6. Existing repositories persist user message, derived reply message, event
   runs, and deterministic LLM traces.
7. API returns `202 accepted`.

## Error Handling

Validation, auth, rate limit, and body errors remain in `apps/api`.

If local ingress dispatch throws, API keeps its existing behavior: it logs the
internal error and returns a redacted `500 internal_error`. The ingress must not
catch workflow failures and report success.

Initialization failures happen before `listen()`, so a misconfigured database
does not produce a healthy API server.

Shutdown closes the Fastify app, local ingress resources, and logger exactly
once.

## Testing

Use TDD.

Focused tests:

- API server composition can initialize a real local ingress against a temporary
  database and `POST /api/v1/messages` returns `202`.
- After the request, SQLite contains the submitted user message, deterministic
  workflow output, event runs, and LLM traces for the request trace.
- Missing or invalid API database configuration fails before listen where
  applicable.
- Shutdown closes the ingress/database and remains idempotent.

Existing API gateway tests continue to cover the optional ingress contract and
`503 core_unavailable` behavior at the app factory level.

## Documentation

Update `docs/web-ui.md` and `README.md` to say the local development server now
injects a deterministic core ingress. Keep the production boundary explicit:
there is still no persistent queue, real platform sender, real model strategy,
run query, or SSE.
