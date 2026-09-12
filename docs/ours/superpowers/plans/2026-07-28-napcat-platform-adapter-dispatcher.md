# NapCat Platform Adapter And Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable NapCat/OneBot 11 platform adapter package and a production bot dispatcher that receives QQ messages, runs the existing Kaguya message workflow, and sends assistant replies back to QQ.

**Architecture:** `@kaguya/platform-adapters` owns platform-neutral contracts, OneBot mapping, and NapCat action sending. `apps/bot` owns production composition: database, event bus, workflow engine, LLM services, configured adapters, and shutdown. The existing message workflow gains an optional sender service and remains usable by the deterministic local demo without platform configuration.

**Tech Stack:** TypeScript `NodeNext`, Vitest, Node 24, workspace packages `@kaguya/schema`, `@kaguya/sdk`, `@kaguya/engine`, `@kaguya/database`, `@kaguya/prompt`, `@kaguya/llm`, `@kaguya/logger`.

## Global Constraints

- Use TDD: write each behavior test first, run it red, then implement.
- Keep `@kaguya/platform-adapters` free of workflow, database, and app imports.
- Keep NapCat/OneBot protocol details out of workflow nodes.
- Do not add media download, reverse WebSocket, HTTP webhook, durable queue replay, or multi-adapter arbitration.
- Use session IDs exactly: `qq:private:<user_id>` and `qq:group:<group_id>`.
- Use trace IDs exactly: `napcat:<self_id-or-unknown>:<message_id>`.
- Do not log NapCat access tokens or message body content.
- Local demo ingress must continue to work without a platform sender.
- `pnpm test` and `pnpm typecheck` must pass before completion.

---

## File Structure

Create `packages/platform-adapters`:

- `packages/platform-adapters/package.json`: workspace package metadata.
- `packages/platform-adapters/tsconfig.json`: package TypeScript build config.
- `packages/platform-adapters/src/types.ts`: platform-neutral contracts.
- `packages/platform-adapters/src/onebot.ts`: OneBot 11 schemas, inbound normalization, and outbound action builders.
- `packages/platform-adapters/src/napcat.ts`: NapCat action client and adapter lifecycle over an injected JSON transport.
- `packages/platform-adapters/src/index.ts`: public exports.
- `packages/platform-adapters/src/onebot.test.ts`: mapper and action builder tests.
- `packages/platform-adapters/src/napcat.test.ts`: action client and adapter transport tests.

Modify existing workflow and services:

- `apps/demo/src/services.ts`: add optional platform sender service getter.
- `apps/demo/src/workflows/shared.ts`: add `sendReplyNode`.
- `apps/demo/src/workflows/message.ts`: add send node after `persist-reply`.
- `apps/demo/src/local-ingress.test.ts`: prove local demo still persists without sending.
- `apps/demo/src/workflows.test.ts`: add sender-aware workflow behavior using the existing harness.

Create `apps/bot`:

- `apps/bot/package.json`: bot app metadata and scripts.
- `apps/bot/tsconfig.json`: bot TypeScript references.
- `apps/bot/src/config.ts`: environment parsing.
- `apps/bot/src/id.ts`: trace-scoped ID factory.
- `apps/bot/src/services.ts`: production workflow service factory.
- `apps/bot/src/dispatcher.ts`: normalized platform inbound to workflow dispatch.
- `apps/bot/src/server.ts`: process entrypoint and lifecycle.
- `apps/bot/src/dispatcher.test.ts`: dispatcher integration tests with fake sender.
- `apps/bot/src/config.test.ts`: environment parsing tests.

Modify workspace files:

- `tsconfig.json`: add references to `packages/platform-adapters` and `apps/bot`.
- `package.json`: add `bot` and `bot:dev` scripts.

---

### Task 1: Platform Adapter Contracts And OneBot Mapping

**Files:**

- Create: `packages/platform-adapters/package.json`
- Create: `packages/platform-adapters/tsconfig.json`
- Create: `packages/platform-adapters/src/types.ts`
- Create: `packages/platform-adapters/src/onebot.ts`
- Create: `packages/platform-adapters/src/index.ts`
- Test: `packages/platform-adapters/src/onebot.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**

- Produces:
  - `PlatformInboundMessage`
  - `PlatformMessageTarget`
  - `PlatformMessageSender`
  - `PlatformDeliveryReceipt`
  - `PlatformReplySender`
  - `normalizeOneBotMessageEvent(input, options): PlatformInboundMessage | undefined`
  - `buildOneBotSendAction(target, text, echo): OneBotActionRequest`
- Consumes: no production code from subsequent tasks.

- [ ] **Step 1: Write package scaffolding**

Create package metadata:

```json
{
  "name": "@kaguya/platform-adapters",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false"
  },
  "dependencies": {
    "@kaguya/schema": "workspace:*"
  }
}
```

Create package `tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../schema" }]
}
```

Add `{ "path": "./packages/platform-adapters" }` to root `tsconfig.json` before app references.

- [ ] **Step 2: Write failing OneBot private mapping test**

Create `packages/platform-adapters/src/onebot.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildOneBotSendAction,
  normalizeOneBotMessageEvent,
} from "./onebot.js";

describe("normalizeOneBotMessageEvent", () => {
  it("maps private text messages to stable Kaguya session and trace IDs", () => {
    const message = normalizeOneBotMessageEvent(
      {
        post_type: "message",
        message_type: "private",
        self_id: 998877,
        message_id: 12345,
        user_id: 112233,
        time: 1785200523,
        sender: { user_id: 112233, nickname: "Ada" },
        message: [{ type: "text", data: { text: "hello kaguya" } }],
      },
      {
        adapterId: "napcat.qq.main",
        now: () => new Date("2026-07-28T01:02:03.000Z"),
      },
    );

    expect(message).toMatchObject({
      platform: "qq",
      adapterId: "napcat.qq.main",
      selfId: "998877",
      sessionId: "qq:private:112233",
      traceId: "napcat:998877:12345",
      platformMessageId: "12345",
      occurredAt: "2026-07-28T03:42:03.000Z",
      text: "hello kaguya",
      target: { kind: "private", userId: "112233" },
      sender: { userId: "112233", nickname: "Ada" },
    });
  });
});

describe("buildOneBotSendAction", () => {
  it("builds private send actions with text segments", () => {
    expect(
      buildOneBotSendAction(
        { kind: "private", userId: "112233" },
        "hi back",
        "echo-1",
      ),
    ).toEqual({
      action: "send_private_msg",
      params: {
        user_id: 112233,
        message: [{ type: "text", data: { text: "hi back" } }],
      },
      echo: "echo-1",
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/platform-adapters/src/onebot.test.ts
```

Expected: FAIL because `packages/platform-adapters/src/onebot.ts` does not exist.

- [ ] **Step 4: Implement minimal contracts and private mapping**

Create `packages/platform-adapters/src/types.ts`:

```ts
export type PlatformName = "qq";

export type PlatformMessageTarget =
  | { readonly kind: "private"; readonly userId: string }
  | { readonly kind: "group"; readonly groupId: string };

export interface PlatformMessageSender {
  readonly userId: string;
  readonly nickname?: string;
  readonly card?: string;
}

export interface PlatformInboundMessage {
  readonly platform: PlatformName;
  readonly adapterId: string;
  readonly selfId?: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly platformMessageId: string;
  readonly occurredAt: string;
  readonly text: string;
  readonly target: PlatformMessageTarget;
  readonly sender: PlatformMessageSender;
  readonly raw: Record<string, unknown>;
}

export interface PlatformDeliveryReceipt {
  readonly ok: boolean;
  readonly adapterId: string;
  readonly platform: PlatformName;
  readonly target: PlatformMessageTarget;
  readonly platformMessageId?: string;
  readonly error?: string;
  readonly raw?: unknown;
}

export interface PlatformReplySender {
  sendTextReply(
    target: PlatformMessageTarget,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<PlatformDeliveryReceipt>;
}
```

Create `packages/platform-adapters/src/onebot.ts` with `z` imported from `@kaguya/schema`. Implement:

```ts
import { z } from "@kaguya/schema";

import type {
  PlatformInboundMessage,
  PlatformMessageSender,
  PlatformMessageTarget,
} from "./types.js";

export interface NormalizeOneBotOptions {
  readonly adapterId: string;
  readonly now: () => Date;
}

export interface OneBotActionRequest {
  readonly action: "send_private_msg" | "send_group_msg";
  readonly params:
    | {
        readonly user_id: number;
        readonly message: readonly OneBotMessageSegment[];
      }
    | {
        readonly group_id: number;
        readonly message: readonly OneBotMessageSegment[];
      };
  readonly echo: string;
}

export type OneBotMessageSegment = {
  readonly type: string;
  readonly data?: Record<string, unknown>;
};

const segmentSchema = z
  .object({
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const eventSchema = z
  .object({
    post_type: z.string().optional(),
    message_type: z.string().optional(),
    self_id: z.union([z.string(), z.number()]).optional(),
    message_id: z.union([z.string(), z.number()]),
    user_id: z.union([z.string(), z.number()]),
    group_id: z.union([z.string(), z.number()]).optional(),
    time: z.number().optional(),
    sender: z.record(z.string(), z.unknown()).optional(),
    message: z.union([z.string(), z.array(segmentSchema)]),
  })
  .passthrough();

export function normalizeOneBotMessageEvent(
  input: unknown,
  options: NormalizeOneBotOptions,
): PlatformInboundMessage | undefined {
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success || parsed.data.post_type !== "message") {
    return undefined;
  }

  const event = parsed.data;
  const messageType = event.message_type;
  if (messageType !== "private" && messageType !== "group") {
    return undefined;
  }

  const platformMessageId = normalizeRequiredId(event.message_id);
  const userId = normalizeRequiredId(event.user_id);
  const selfId = normalizeOptionalId(event.self_id);
  const text = normalizeMessageText(event.message).trim();
  if (!platformMessageId || !userId || !text) {
    return undefined;
  }

  const target = targetFor(messageType, event.group_id, userId);
  if (target === undefined) {
    return undefined;
  }

  const sessionId =
    target.kind === "private"
      ? `qq:private:${target.userId}`
      : `qq:group:${target.groupId}`;
  const traceId = `napcat:${selfId ?? "unknown"}:${platformMessageId}`;

  return {
    platform: "qq",
    adapterId: options.adapterId,
    ...(selfId === undefined ? {} : { selfId }),
    sessionId,
    traceId,
    platformMessageId,
    occurredAt:
      event.time === undefined
        ? options.now().toISOString()
        : new Date(event.time * 1000).toISOString(),
    text,
    target,
    sender: senderFor(event.sender, userId),
    raw: input as Record<string, unknown>,
  };
}

export function buildOneBotSendAction(
  target: PlatformMessageTarget,
  text: string,
  echo: string,
): OneBotActionRequest {
  const message = [{ type: "text", data: { text } }] as const;
  if (target.kind === "private") {
    return {
      action: "send_private_msg",
      params: { user_id: Number(target.userId), message },
      echo,
    };
  }
  return {
    action: "send_group_msg",
    params: { group_id: Number(target.groupId), message },
    echo,
  };
}

function targetFor(
  messageType: "private" | "group",
  groupIdValue: string | number | undefined,
  userId: string,
): PlatformMessageTarget | undefined {
  if (messageType === "private") {
    return { kind: "private", userId };
  }
  const groupId = normalizeOptionalId(groupIdValue);
  return groupId === undefined ? undefined : { kind: "group", groupId };
}

function senderFor(
  sender: Record<string, unknown> | undefined,
  fallbackUserId: string,
): PlatformMessageSender {
  const userId = normalizeOptionalId(sender?.user_id) ?? fallbackUserId;
  const nickname = normalizeOptionalText(sender?.nickname);
  const card = normalizeOptionalText(sender?.card);
  return {
    userId,
    ...(nickname === undefined ? {} : { nickname }),
    ...(card === undefined ? {} : { card }),
  };
}

function normalizeMessageText(
  message: string | readonly OneBotMessageSegment[],
): string {
  if (typeof message === "string") {
    return message;
  }
  return message
    .map(segmentToText)
    .join("")
    .replace(/[ \t]+\n/g, "\n");
}

function segmentToText(segment: OneBotMessageSegment): string {
  if (segment.type === "text") {
    return normalizeOptionalText(segment.data?.text) ?? "";
  }
  if (segment.type === "at") {
    const qq = normalizeOptionalText(segment.data?.qq) ?? "unknown";
    return `@${qq}`;
  }
  if (segment.type === "reply") {
    const id = normalizeOptionalText(segment.data?.id) ?? "unknown";
    return `[reply:${id}]`;
  }
  if (segment.type === "image") {
    return "[image]";
  }
  if (segment.type === "face") {
    const id = normalizeOptionalText(segment.data?.id) ?? "unknown";
    return `[face:${id}]`;
  }
  return `[${segment.type}]`;
}

function normalizeRequiredId(value: string | number): string {
  return String(value).trim();
}

function normalizeOptionalId(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === "boolean") {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}
```

Create `packages/platform-adapters/src/index.ts`:

```ts
export type {
  PlatformDeliveryReceipt,
  PlatformInboundMessage,
  PlatformMessageSender,
  PlatformMessageTarget,
  PlatformName,
  PlatformReplySender,
} from "./types.js";
export {
  buildOneBotSendAction,
  normalizeOneBotMessageEvent,
  type NormalizeOneBotOptions,
  type OneBotActionRequest,
  type OneBotMessageSegment,
} from "./onebot.js";
```

- [ ] **Step 5: Run private mapping test to verify it passes**

Run:

```bash
pnpm vitest run packages/platform-adapters/src/onebot.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write failing group and ignore tests**

Append to `onebot.test.ts`:

```ts
it("maps group messages to group sessions and degraded segment text", () => {
  const message = normalizeOneBotMessageEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: "998877",
      message_id: "abc-1",
      user_id: "445566",
      group_id: "778899",
      sender: { user_id: "445566", nickname: "Lin", card: "林" },
      message: [
        { type: "reply", data: { id: "old-msg" } },
        { type: "at", data: { qq: "998877" } },
        { type: "text", data: { text: "hi" } },
        { type: "image", data: { file: "x.jpg" } },
      ],
    },
    {
      adapterId: "napcat.qq.main",
      now: () => new Date("2026-07-28T01:02:03.000Z"),
    },
  );

  expect(message).toMatchObject({
    sessionId: "qq:group:778899",
    traceId: "napcat:998877:abc-1",
    text: "[reply:old-msg]@998877hi[image]",
    target: { kind: "group", groupId: "778899" },
    sender: { userId: "445566", nickname: "Lin", card: "林" },
  });
});

it("ignores non-message events and blank normalized messages", () => {
  const options = {
    adapterId: "napcat.qq.main",
    now: () => new Date("2026-07-28T01:02:03.000Z"),
  };

  expect(
    normalizeOneBotMessageEvent(
      { post_type: "meta_event", message_id: 1, user_id: 2, message: "x" },
      options,
    ),
  ).toBeUndefined();
  expect(
    normalizeOneBotMessageEvent(
      {
        post_type: "message",
        message_type: "private",
        message_id: 1,
        user_id: 2,
        message: [{ type: "text", data: { text: "   " } }],
      },
      options,
    ),
  ).toBeUndefined();
});

it("builds group send actions with text segments", () => {
  expect(
    buildOneBotSendAction(
      { kind: "group", groupId: "778899" },
      "group reply",
      "echo-2",
    ),
  ).toEqual({
    action: "send_group_msg",
    params: {
      group_id: 778899,
      message: [{ type: "text", data: { text: "group reply" } }],
    },
    echo: "echo-2",
  });
});
```

- [ ] **Step 7: Run group and ignore tests**

Run:

```bash
pnpm vitest run packages/platform-adapters/src/onebot.test.ts
```

Expected: PASS. A failure should name the incorrect `sessionId`, `target`, blank ignore behavior, or segment text.

- [ ] **Step 8: Correct any group or ignore regression**

Adjust only `normalizeOneBotMessageEvent`, `targetFor`, or `segmentToText` until the Step 6 tests pass. Keep expected strings exactly as listed above.

- [ ] **Step 9: Run package typecheck**

Run:

```bash
pnpm --filter @kaguya/platform-adapters typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add tsconfig.json packages/platform-adapters
git commit -m "feat: add onebot platform message mapping"
```

---

### Task 2: NapCat Action Client And Adapter Transport

**Files:**

- Create: `packages/platform-adapters/src/napcat.ts`
- Test: `packages/platform-adapters/src/napcat.test.ts`
- Modify: `packages/platform-adapters/src/index.ts`

**Interfaces:**

- Consumes:
  - `PlatformMessageTarget`
  - `PlatformInboundMessage`
  - `PlatformReplySender`
  - `normalizeOneBotMessageEvent(input, options)`
  - `buildOneBotSendAction(target, text, echo)`
- Produces:
  - `JsonMessageTransport`
  - `NapCatActionClient implements PlatformReplySender`
  - `NapCatOneBotAdapter`

- [ ] **Step 1: Write failing action client tests**

Create `packages/platform-adapters/src/napcat.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { NapCatActionClient, type JsonMessageTransport } from "./napcat.js";

class FakeTransport implements JsonMessageTransport {
  readonly sent: unknown[] = [];
  private messageHandler: ((message: unknown) => void) | undefined;
  private closeHandler: ((error?: Error) => void) | undefined;

  sendJson(message: unknown): void {
    this.sent.push(message);
  }

  onJsonMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closeHandler?.();
  }

  receive(message: unknown): void {
    this.messageHandler?.(message);
  }
}

describe("NapCatActionClient", () => {
  it("sends a private action and resolves the matching echo response", async () => {
    const transport = new FakeTransport();
    const client = new NapCatActionClient({
      adapterId: "napcat.qq.main",
      transport,
      nextEcho: () => "echo-1",
      timeoutMs: 1000,
    });

    const promise = client.sendTextReply(
      { kind: "private", userId: "112233" },
      "hi",
    );

    expect(transport.sent).toEqual([
      {
        action: "send_private_msg",
        params: {
          user_id: 112233,
          message: [{ type: "text", data: { text: "hi" } }],
        },
        echo: "echo-1",
      },
    ]);

    transport.receive({
      status: "ok",
      retcode: 0,
      data: { message_id: 24680 },
      echo: "echo-1",
    });

    await expect(promise).resolves.toMatchObject({
      ok: true,
      adapterId: "napcat.qq.main",
      platform: "qq",
      target: { kind: "private", userId: "112233" },
      platformMessageId: "24680",
    });
  });

  it("returns failed receipts for matching failed action responses", async () => {
    const transport = new FakeTransport();
    const client = new NapCatActionClient({
      adapterId: "napcat.qq.main",
      transport,
      nextEcho: () => "echo-2",
      timeoutMs: 1000,
    });

    const promise = client.sendTextReply(
      { kind: "group", groupId: "778899" },
      "nope",
    );
    transport.receive({
      status: "failed",
      retcode: 1404,
      wording: "group not found",
      echo: "echo-2",
    });

    await expect(promise).resolves.toMatchObject({
      ok: false,
      error: "group not found",
      target: { kind: "group", groupId: "778899" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/platform-adapters/src/napcat.test.ts
```

Expected: FAIL because `napcat.ts` does not exist.

- [ ] **Step 3: Implement action client**

Create `packages/platform-adapters/src/napcat.ts`:

```ts
import type {
  PlatformDeliveryReceipt,
  PlatformInboundMessage,
  PlatformMessageTarget,
  PlatformReplySender,
} from "./types.js";
import {
  buildOneBotSendAction,
  normalizeOneBotMessageEvent,
} from "./onebot.js";

export interface JsonMessageTransport {
  sendJson(message: unknown): void;
  onJsonMessage(handler: (message: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

export interface NapCatActionClientOptions {
  readonly adapterId: string;
  readonly transport: JsonMessageTransport;
  readonly nextEcho: () => string;
  readonly timeoutMs: number;
}

interface PendingAction {
  readonly target: PlatformMessageTarget;
  readonly resolve: (receipt: PlatformDeliveryReceipt) => void;
  readonly timer: NodeJS.Timeout;
}

export class NapCatActionClient implements PlatformReplySender {
  private readonly pending = new Map<string, PendingAction>();

  constructor(private readonly options: NapCatActionClientOptions) {
    options.transport.onJsonMessage((message) => {
      this.handleJsonMessage(message);
    });
    options.transport.onClose((error) => {
      this.rejectAll(error?.message ?? "NapCat connection closed");
    });
  }

  async sendTextReply(
    target: PlatformMessageTarget,
    text: string,
  ): Promise<PlatformDeliveryReceipt> {
    const echo = this.options.nextEcho();
    const request = buildOneBotSendAction(target, text, echo);
    const receipt = new Promise<PlatformDeliveryReceipt>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        resolve({
          ok: false,
          adapterId: this.options.adapterId,
          platform: "qq",
          target,
          error: "NapCat action timed out",
        });
      }, this.options.timeoutMs);
      this.pending.set(echo, { target, resolve, timer });
    });
    this.options.transport.sendJson(request);
    return receipt;
  }

  private handleJsonMessage(message: unknown): void {
    if (
      typeof message !== "object" ||
      message === null ||
      !("echo" in message)
    ) {
      return;
    }
    const echo = String((message as { echo: unknown }).echo);
    const pending = this.pending.get(echo);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(echo);
    clearTimeout(pending.timer);

    const body = message as {
      status?: unknown;
      data?: unknown;
      wording?: unknown;
      message?: unknown;
    };
    if (body.status === "ok") {
      pending.resolve({
        ok: true,
        adapterId: this.options.adapterId,
        platform: "qq",
        target: pending.target,
        platformMessageId: extractMessageId(body.data),
        raw: message,
      });
      return;
    }

    pending.resolve({
      ok: false,
      adapterId: this.options.adapterId,
      platform: "qq",
      target: pending.target,
      error: extractError(body),
      raw: message,
    });
  }

  private rejectAll(error: string): void {
    for (const [echo, pending] of this.pending) {
      this.pending.delete(echo);
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        adapterId: this.options.adapterId,
        platform: "qq",
        target: pending.target,
        error,
      });
    }
  }
}

export interface NapCatOneBotAdapterOptions {
  readonly adapterId: string;
  readonly transport: JsonMessageTransport;
  readonly now: () => Date;
  readonly onInboundMessage: (message: PlatformInboundMessage) => Promise<void>;
}

export class NapCatOneBotAdapter {
  constructor(private readonly options: NapCatOneBotAdapterOptions) {
    options.transport.onJsonMessage((message) => {
      void this.handleJsonMessage(message);
    });
  }

  async start(): Promise<void> {
    return undefined;
  }

  async stop(): Promise<void> {
    this.options.transport.close();
  }

  private async handleJsonMessage(message: unknown): Promise<void> {
    if (typeof message === "object" && message !== null && "echo" in message) {
      return;
    }
    const inbound = normalizeOneBotMessageEvent(message, {
      adapterId: this.options.adapterId,
      now: this.options.now,
    });
    if (inbound === undefined) {
      return;
    }
    await this.options.onInboundMessage(inbound);
  }
}

function extractMessageId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("message_id" in data)) {
    return undefined;
  }
  const value = (data as { message_id: unknown }).message_id;
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function extractError(body: { wording?: unknown; message?: unknown }): string {
  const wording = typeof body.wording === "string" ? body.wording.trim() : "";
  if (wording) {
    return wording;
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  return message || "NapCat action failed";
}
```

Export from `index.ts`:

```ts
export {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type JsonMessageTransport,
  type NapCatActionClientOptions,
  type NapCatOneBotAdapterOptions,
} from "./napcat.js";
```

- [ ] **Step 4: Run action tests**

Run:

```bash
pnpm vitest run packages/platform-adapters/src/napcat.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing adapter inbound test**

Append to `napcat.test.ts`:

```ts
import { vi } from "vitest";

import { NapCatOneBotAdapter } from "./napcat.js";

it("dispatches normalized inbound messages and ignores action responses", async () => {
  const transport = new FakeTransport();
  const onInboundMessage = vi.fn<
    [(typeof import("./types.js"))["PlatformInboundMessage"]],
    Promise<void>
  >(async () => undefined);
  const adapter = new NapCatOneBotAdapter({
    adapterId: "napcat.qq.main",
    transport,
    now: () => new Date("2026-07-28T01:02:03.000Z"),
    onInboundMessage,
  });

  await adapter.start();
  transport.receive({ status: "ok", echo: "echo-ignored" });
  transport.receive({
    post_type: "message",
    message_type: "private",
    message_id: 123,
    user_id: 456,
    message: "hello",
  });

  await Promise.resolve();

  expect(onInboundMessage).toHaveBeenCalledTimes(1);
  expect(onInboundMessage.mock.calls[0]?.[0]).toMatchObject({
    sessionId: "qq:private:456",
    text: "hello",
  });
});
```

- [ ] **Step 6: Run adapter test**

Run:

```bash
pnpm vitest run packages/platform-adapters/src/napcat.test.ts
```

Expected: PASS. Use this concrete no-mock variant if the `vi.fn` generic signature conflicts with the installed Vitest types:

```ts
const inboundMessages: unknown[] = [];
const onInboundMessage = async (message: unknown) => {
  inboundMessages.push(message);
};
```

and assert against `inboundMessages`.

- [ ] **Step 7: Run package tests and typecheck**

Run:

```bash
pnpm vitest run packages/platform-adapters/src/onebot.test.ts packages/platform-adapters/src/napcat.test.ts
pnpm --filter @kaguya/platform-adapters typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/platform-adapters
git commit -m "feat: add napcat action client"
```

---

### Task 3: Optional Platform Sender In Message Workflow

**Files:**

- Modify: `apps/demo/src/services.ts`
- Modify: `apps/demo/src/workflows/shared.ts`
- Modify: `apps/demo/src/workflows/message.ts`
- Test: `apps/demo/src/local-ingress.test.ts`
- Test: `apps/demo/src/workflows.test.ts`
- Modify: `apps/demo/package.json`
- Modify: `apps/demo/tsconfig.json`

**Interfaces:**

- Consumes:
  - `PlatformReplySender`
  - `PlatformMessageTarget`
  - `PlatformDeliveryReceipt`
- Produces:
  - `getPlatformReplySender(context): PlatformReplySender | undefined`
  - `sendReplyNode`
  - `createMessageWorkflow()` that sends after `persist-reply` only when a sender is configured.

- [ ] **Step 1: Add dependency references**

Modify `apps/demo/package.json` dependencies:

```json
"@kaguya/platform-adapters": "workspace:*"
```

Modify `apps/demo/tsconfig.json` references:

```json
{ "path": "../../packages/platform-adapters" }
```

- [ ] **Step 2: Write failing sender workflow test**

Open `apps/demo/src/workflows.test.ts`. Add imports:

```ts
import type {
  PlatformDeliveryReceipt,
  PlatformMessageTarget,
  PlatformReplySender,
} from "@kaguya/platform-adapters";
```

Add a test near the existing message workflow tests:

```ts
it("sends persisted assistant replies through the configured platform sender", async () => {
  const sent: Array<{ target: PlatformMessageTarget; text: string }> = [];
  const platformReplySender: PlatformReplySender = {
    async sendTextReply(target, text): Promise<PlatformDeliveryReceipt> {
      sent.push({ target, text });
      return {
        ok: true,
        adapterId: "napcat.qq.main",
        platform: "qq",
        target,
        platformMessageId: "sent-1",
      };
    },
  };

  const result = await runMessageWorkflowForTest({
    eventMetadata: {
      target: { kind: "private", userId: "112233" },
    },
    services: { platformReplySender },
  });

  expect(sent).toEqual([
    {
      target: { kind: "private", userId: "112233" },
      text: "It is a lovely night for watching the moon.",
    },
  ]);
  expect(result.nodeResults.get("send-reply")).toMatchObject({
    ok: true,
    platformMessageId: "sent-1",
  });
});
```

Add this helper to `apps/demo/src/workflows.test.ts` near `createHarness`:

```ts
async function runMessageWorkflowForTest(options: {
  eventMetadata?: Record<string, unknown>;
  services?: Partial<WorkflowServices>;
}) {
  const harness = createHarness([
    { shouldReply: true, reason: "direct question" },
    { text: "It is a lovely night for watching the moon." },
  ]);
  Object.assign(harness.contextServices, options.services ?? {});
  const event = messageReceivedEvent.create(
    {
      id: "message-platform-send",
      source: "integration-test",
      occurredAt: NOW,
      traceId: "trace-message-platform-send",
      sessionId: "session-message-platform-send",
      metadata: options.eventMetadata ?? {},
    },
    { text: "How is the moon?" },
  );
  harness.contextServices.messageReceivedEvent = event;
  try {
    return await dispatchEvent({
      definition: messageReceivedEvent,
      event,
      eventBus: harness.eventBus,
      engine: harness.engine,
      workflow: createMessageWorkflow(),
      context: harness.context(event),
    });
  } finally {
    harness.database.close();
  }
}
```

Expose `services` from `createHarness` by returning it as `contextServices`:

```ts
return {
  database,
  engine,
  eventBus,
  contextServices: services,
  context(
    event: Pick<EventEnvelope, "traceId" | "sessionId">,
  ): WorkflowContext {
    return {
      traceId: event.traceId,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      now,
      nextId,
      services,
    };
  },
};
```

- [ ] **Step 3: Run sender workflow test to verify it fails**

Run:

```bash
pnpm vitest run apps/demo/src/workflows.test.ts -t "sends persisted assistant replies"
```

Expected: FAIL because there is no `platformReplySender` service or `send-reply` node.

- [ ] **Step 4: Implement service getter**

Modify `apps/demo/src/services.ts`:

```ts
import type { PlatformReplySender } from "@kaguya/platform-adapters";
```

Extend `WorkflowServices`:

```ts
platformReplySender?: PlatformReplySender;
```

Add:

```ts
export function getPlatformReplySender(
  context: WorkflowContext,
): PlatformReplySender | undefined {
  const service = context.services.platformReplySender;
  if (service === undefined) {
    return undefined;
  }
  return service as PlatformReplySender;
}
```

- [ ] **Step 5: Implement send node**

Modify `apps/demo/src/workflows/shared.ts` imports:

```ts
import type {
  PlatformDeliveryReceipt,
  PlatformMessageTarget,
} from "@kaguya/platform-adapters";
```

Import `getPlatformReplySender`.

Add:

```ts
export interface SendReplyInput {
  readonly event: EventEnvelope;
  readonly reply: MessageRecord;
}

export const sendReplyNode: WorkflowNode<
  SendReplyInput,
  PlatformDeliveryReceipt | undefined
> = defineNode({
  id: "send-reply",
  async run(input, context) {
    const sender = getPlatformReplySender(context);
    if (sender === undefined) {
      return undefined;
    }
    if (input.reply.role !== "assistant") {
      throw new Error("send-reply only supports assistant messages");
    }
    const target = parsePlatformTarget(input.event.metadata.target);
    if (target === undefined) {
      return undefined;
    }
    return sender.sendTextReply(target, input.reply.content, {
      traceId: context.traceId,
      sessionId: requiredSessionId(context),
      messageId: input.reply.id,
    });
  },
});

export function parsePlatformTarget(
  value: unknown,
): PlatformMessageTarget | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return undefined;
  }
  if ((value as { kind: unknown }).kind === "private") {
    const userId = normalizeTargetId((value as { userId?: unknown }).userId);
    return userId === undefined ? undefined : { kind: "private", userId };
  }
  if ((value as { kind: unknown }).kind === "group") {
    const groupId = normalizeTargetId((value as { groupId?: unknown }).groupId);
    return groupId === undefined ? undefined : { kind: "group", groupId };
  }
  return undefined;
}

function normalizeTargetId(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === "boolean") {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}
```

- [ ] **Step 6: Thread original event into send node**

Modify `apps/demo/src/workflows/message.ts` so the edge from `persist-reply` produces `{ event, reply }`. The simple way is to add a wrapper node between `persist-reply` and `send-reply`:

```ts
const prepareSendReplyNode = defineNode<MessageRecord, SendReplyInput>({
  id: "prepare-send-reply",
  async run(reply, context) {
    const originalEvent = context.services.messageReceivedEvent;
    const eventEnvelope = eventEnvelopeSchema.parse(originalEvent);
    return { event: eventEnvelope, reply };
  },
});
```

Add `messageReceivedEvent` to the services object wherever a message workflow dispatch is created. In `local-ingress.ts`, set it before dispatch:

```ts
const services = createWorkflowServices(...);
services.messageReceivedEvent = event;
```

In the task implementation, prefer a typed `WorkflowServices` field:

```ts
messageReceivedEvent?: EventEnvelope;
```

Update `createMessageWorkflow()` nodes and edges:

```ts
nodes: [
  persistMessageNode,
  loadContextNode,
  compileRouteNode,
  decideRouteNode,
  compileReplyNode,
  createGenerateReplyNode("message-workflow"),
  persistReplyNode,
  prepareSendReplyNode,
  sendReplyNode,
],
edges: [
  { from: "persist-message", to: "load-context" },
  { from: "load-context", to: "compile-route" },
  { from: "compile-route", to: "decide-route" },
  {
    from: "decide-route",
    to: "compile-reply",
    when: (result) => routeDecisionSchema.parse(result).shouldReply,
  },
  { from: "compile-reply", to: "generate-reply" },
  { from: "generate-reply", to: "persist-reply" },
  { from: "persist-reply", to: "prepare-send-reply" },
  { from: "prepare-send-reply", to: "send-reply" },
],
```

- [ ] **Step 7: Run sender workflow test**

Run:

```bash
pnpm vitest run apps/demo/src/workflows.test.ts -t "sends persisted assistant replies"
```

Expected: PASS.

- [ ] **Step 8: Verify local ingress still works without sender**

Run:

```bash
pnpm vitest run apps/demo/src/local-ingress.test.ts
```

Expected: PASS. Existing assertions should still find one user and one assistant message per local ingress input.

- [ ] **Step 9: Run demo tests and typecheck**

Run:

```bash
pnpm vitest run apps/demo/src/workflows.test.ts apps/demo/src/local-ingress.test.ts
pnpm --filter @kaguya/demo typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/demo
git commit -m "feat: add optional platform reply sender"
```

---

### Task 4: Production Platform Dispatcher

**Files:**

- Create: `apps/bot/package.json`
- Create: `apps/bot/tsconfig.json`
- Create: `apps/bot/src/id.ts`
- Create: `apps/bot/src/services.ts`
- Create: `apps/bot/src/dispatcher.ts`
- Test: `apps/bot/src/dispatcher.test.ts`
- Modify: `apps/demo/src/workflows.ts`
- Modify: `tsconfig.json`

**Interfaces:**

- Consumes:
  - `PlatformInboundMessage`
  - `PlatformReplySender`
  - `createMessageWorkflow()`
  - `dispatchEvent()`
  - `messageReceivedEvent`
- Produces:
  - `createTraceScopedIdFactory(traceId): (prefix: string) => string`
  - `PlatformDispatcher`
  - `createBotWorkflowServices(options): WorkflowServices`

- [ ] **Step 1: Create bot app scaffolding**

Create `apps/bot/package.json`:

```json
{
  "name": "@kaguya/bot",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false",
    "start": "node dist/server.js",
    "dev": "pnpm --filter @kaguya/bot... build && tsx src/server.ts"
  },
  "dependencies": {
    "@kaguya/database": "workspace:*",
    "@kaguya/demo": "workspace:*",
    "@kaguya/engine": "workspace:*",
    "@kaguya/llm": "workspace:*",
    "@kaguya/logger": "workspace:*",
    "@kaguya/platform-adapters": "workspace:*",
    "@kaguya/prompt": "workspace:*",
    "@kaguya/sdk": "workspace:*"
  }
}
```

Create `apps/bot/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../demo" },
    { "path": "../../packages/database" },
    { "path": "../../packages/engine" },
    { "path": "../../packages/llm" },
    { "path": "../../packages/logger" },
    { "path": "../../packages/platform-adapters" },
    { "path": "../../packages/prompt" },
    { "path": "../../packages/sdk" }
  ]
}
```

Add `{ "path": "./apps/bot" }` to root `tsconfig.json` after `apps/api`.

- [ ] **Step 2: Write failing dispatcher integration test**

Create `apps/bot/src/dispatcher.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import type {
  PlatformDeliveryReceipt,
  PlatformMessageTarget,
  PlatformReplySender,
} from "@kaguya/platform-adapters";
import { afterEach, describe, expect, it } from "vitest";

import { PlatformDispatcher } from "./dispatcher.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "kaguya-bot-dispatcher-"));
  roots.push(root);
  return join(root, "kaguya.sqlite");
}

describe("PlatformDispatcher", () => {
  it("runs the message workflow and sends assistant replies to the original target", async () => {
    const databasePath = tempDatabasePath();
    const sent: Array<{ target: PlatformMessageTarget; text: string }> = [];
    const platformReplySender: PlatformReplySender = {
      async sendTextReply(target, text): Promise<PlatformDeliveryReceipt> {
        sent.push({ target, text });
        return {
          ok: true,
          adapterId: "napcat.qq.main",
          platform: "qq",
          target,
          platformMessageId: "sent-1",
        };
      },
    };
    const dispatcher = PlatformDispatcher.createForDeterministicModel({
      databasePath,
      platformReplySender,
      now: () => new Date("2026-07-28T01:02:03.000Z"),
    });

    await dispatcher.dispatchInboundMessage({
      platform: "qq",
      adapterId: "napcat.qq.main",
      selfId: "998877",
      sessionId: "qq:private:112233",
      traceId: "napcat:998877:12345",
      platformMessageId: "12345",
      occurredAt: "2026-07-28T01:01:00.000Z",
      text: "hello from qq",
      target: { kind: "private", userId: "112233" },
      sender: { userId: "112233", nickname: "Ada" },
      raw: { redacted: true },
    });
    dispatcher.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      const messages = database.messages.listRecent("qq:private:112233", 10);
      expect(messages.map((message) => message.role).sort()).toEqual([
        "assistant",
        "user",
      ]);
      expect(messages.find((message) => message.role === "user")).toMatchObject(
        {
          content: "hello from qq",
          metadata: {
            adapterId: "napcat.qq.main",
            platform: "qq",
            platformMessageId: "12345",
            target: { kind: "private", userId: "112233" },
            sender: { userId: "112233", nickname: "Ada" },
          },
        },
      );
      expect(sent).toEqual([
        {
          target: { kind: "private", userId: "112233" },
          text: "It is a lovely night for watching the moon.",
        },
      ]);
      expect(
        database.llmTraces.listByTrace("napcat:998877:12345"),
      ).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
```

- [ ] **Step 3: Run dispatcher test to verify it fails**

Run:

```bash
pnpm vitest run apps/bot/src/dispatcher.test.ts
```

Expected: FAIL because `dispatcher.ts` does not exist.

- [ ] **Step 4: Implement trace ID factory**

Create `apps/bot/src/id.ts`:

```ts
export function createTraceScopedIdFactory(
  traceId: string,
): (prefix: string) => string {
  let sequence = 0;
  return (prefix: string) =>
    `${traceId}-${prefix}-${String(++sequence).padStart(6, "0")}`;
}
```

- [ ] **Step 5: Implement service factory**

Create `apps/bot/src/services.ts`:

```ts
import { KaguyaDatabase } from "@kaguya/database";
import { EventBus } from "@kaguya/engine";
import { KaguyaLlmClient, createDeterministicModel } from "@kaguya/llm";
import type { PlatformReplySender } from "@kaguya/platform-adapters";
import { PromptCompiler } from "@kaguya/prompt";

import { LlmLifecycleClient, type WorkflowServices } from "@kaguya/demo";

export interface CreateBotWorkflowServicesOptions {
  readonly database: KaguyaDatabase;
  readonly eventBus: EventBus;
  readonly promptCompiler: PromptCompiler;
  readonly now: () => Date;
  readonly nextId: (prefix: string) => string;
  readonly platformReplySender?: PlatformReplySender;
}

export function createBotWorkflowServices(
  options: CreateBotWorkflowServicesOptions,
): WorkflowServices {
  return {
    database: options.database,
    promptCompiler: options.promptCompiler,
    llmClient: new LlmLifecycleClient(
      new KaguyaLlmClient({
        model: createDeterministicModel([
          {
            shouldReply: true,
            reason: "the platform message should enter the workflow",
          },
          { text: "It is a lovely night for watching the moon." },
        ]),
        traceWriter: options.database.llmTraces,
        now: options.now,
        nextId: options.nextId,
      }),
      options.eventBus,
    ),
    eventBus: options.eventBus,
    ...(options.platformReplySender === undefined
      ? {}
      : { platformReplySender: options.platformReplySender }),
  };
}
```

Modify `apps/demo/src/workflows.ts` to export the service types used by `apps/bot`:

```ts
export { LlmLifecycleClient } from "./llm-lifecycle.js";
export type { WorkflowServices } from "./services.js";
```

- [ ] **Step 6: Implement dispatcher**

Create `apps/bot/src/dispatcher.ts`:

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import {
  createMessageWorkflow,
  dispatchEvent,
  messageReceivedEvent,
} from "@kaguya/demo";
import { EventBus, WorkflowEngine } from "@kaguya/engine";
import type {
  PlatformInboundMessage,
  PlatformReplySender,
} from "@kaguya/platform-adapters";
import { PromptCompiler } from "@kaguya/prompt";
import type { WorkflowContext } from "@kaguya/sdk";

import { createTraceScopedIdFactory } from "./id.js";
import { createBotWorkflowServices } from "./services.js";

export interface CreatePlatformDispatcherOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly platformReplySender?: PlatformReplySender;
}

export class PlatformDispatcher {
  static createForDeterministicModel(
    options: CreatePlatformDispatcherOptions,
  ): PlatformDispatcher {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    const database = KaguyaDatabase.open(options.databasePath);
    database.migrate();
    return new PlatformDispatcher({
      database,
      eventBus: new EventBus(),
      engine: new WorkflowEngine({ recorder: database.eventRuns }),
      promptCompiler: new PromptCompiler(),
      now: options.now ?? (() => new Date()),
      platformReplySender: options.platformReplySender,
    });
  }

  private readonly workflow = createMessageWorkflow();

  constructor(
    private readonly options: {
      readonly database: KaguyaDatabase;
      readonly eventBus: EventBus;
      readonly engine: WorkflowEngine;
      readonly promptCompiler: PromptCompiler;
      readonly now: () => Date;
      readonly platformReplySender?: PlatformReplySender;
    },
  ) {}

  async dispatchInboundMessage(message: PlatformInboundMessage): Promise<void> {
    const nextId = createTraceScopedIdFactory(message.traceId);
    const event = messageReceivedEvent.create(
      {
        id: `${message.traceId}-message-received`,
        source: `adapter:${message.adapterId}`,
        occurredAt: message.occurredAt,
        traceId: message.traceId,
        sessionId: message.sessionId,
        metadata: {
          adapterId: message.adapterId,
          platform: message.platform,
          platformMessageId: message.platformMessageId,
          ...(message.selfId === undefined ? {} : { selfId: message.selfId }),
          target: message.target,
          sender: message.sender,
        },
      },
      { text: message.text },
    );
    const services = createBotWorkflowServices({
      database: this.options.database,
      eventBus: this.options.eventBus,
      promptCompiler: this.options.promptCompiler,
      now: this.options.now,
      nextId,
      platformReplySender: this.options.platformReplySender,
    });
    services.messageReceivedEvent = event;

    const context: WorkflowContext = {
      traceId: message.traceId,
      sessionId: message.sessionId,
      now: this.options.now,
      nextId,
      services,
    };

    await dispatchEvent({
      definition: messageReceivedEvent,
      event,
      eventBus: this.options.eventBus,
      engine: this.options.engine,
      workflow: this.workflow,
      context,
    });
  }

  close(): void {
    this.options.database.close();
  }
}
```

- [ ] **Step 7: Run dispatcher test**

Run:

```bash
pnpm vitest run apps/bot/src/dispatcher.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run bot typecheck**

Run:

```bash
pnpm --filter @kaguya/bot typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add tsconfig.json apps/bot apps/demo/src/workflows.ts
git commit -m "feat: add production platform dispatcher"
```

---

### Task 5: Bot Runtime Configuration And NapCat Wiring

**Files:**

- Create: `apps/bot/src/config.ts`
- Create: `apps/bot/src/server.ts`
- Test: `apps/bot/src/config.test.ts`
- Modify: `apps/bot/src/dispatcher.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes:
  - `PlatformDispatcher`
  - `NapCatActionClient`
  - `NapCatOneBotAdapter`
  - `JsonMessageTransport`
- Produces:
  - `readBotConfig(environment): BotConfig`
  - `startBot(): Promise<void>`
  - `WebSocketJsonTransport`

- [ ] **Step 1: Write failing config tests**

Create `apps/bot/src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { readBotConfig } from "./config.js";

describe("readBotConfig", () => {
  it("reads enabled NapCat configuration", () => {
    expect(
      readBotConfig({
        KAGUYA_BOT_DATABASE_PATH: "/tmp/kaguya.sqlite",
        KAGUYA_NAPCAT_ENABLED: "true",
        KAGUYA_NAPCAT_WS_URL: "ws://127.0.0.1:3001",
        KAGUYA_NAPCAT_ACCESS_TOKEN: "secret-token",
        KAGUYA_NAPCAT_SELF_ID: "998877",
        KAGUYA_NAPCAT_RECONNECT_MS: "5000",
      }),
    ).toEqual({
      databasePath: "/tmp/kaguya.sqlite",
      napcat: {
        enabled: true,
        adapterId: "napcat.qq.main",
        wsUrl: "ws://127.0.0.1:3001",
        accessToken: "secret-token",
        selfId: "998877",
        reconnectMs: 5000,
      },
    });
  });

  it("requires ws url when NapCat is enabled", () => {
    expect(() => readBotConfig({ KAGUYA_NAPCAT_ENABLED: "true" })).toThrow(
      "KAGUYA_NAPCAT_WS_URL is required when KAGUYA_NAPCAT_ENABLED=true",
    );
  });
});
```

- [ ] **Step 2: Run config tests to verify they fail**

Run:

```bash
pnpm vitest run apps/bot/src/config.test.ts
```

Expected: FAIL because `config.ts` does not exist.

- [ ] **Step 3: Implement config parser**

Create `apps/bot/src/config.ts`:

```ts
import { fileURLToPath } from "node:url";

const defaultDatabasePath = fileURLToPath(
  new URL("../../../.data/kaguya-bot.sqlite", import.meta.url),
);

export interface BotConfig {
  readonly databasePath: string;
  readonly napcat: NapCatConfig;
}

export interface NapCatConfig {
  readonly enabled: boolean;
  readonly adapterId: string;
  readonly wsUrl?: string;
  readonly accessToken?: string;
  readonly selfId?: string;
  readonly reconnectMs: number;
}

export function readBotConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BotConfig {
  const enabled = environment.KAGUYA_NAPCAT_ENABLED?.trim() === "true";
  const wsUrl = optionalText(environment.KAGUYA_NAPCAT_WS_URL);
  if (enabled && wsUrl === undefined) {
    throw new Error(
      "KAGUYA_NAPCAT_WS_URL is required when KAGUYA_NAPCAT_ENABLED=true",
    );
  }

  return {
    databasePath:
      optionalText(environment.KAGUYA_BOT_DATABASE_PATH) ?? defaultDatabasePath,
    napcat: {
      enabled,
      adapterId: "napcat.qq.main",
      ...(wsUrl === undefined ? {} : { wsUrl }),
      ...(optionalText(environment.KAGUYA_NAPCAT_ACCESS_TOKEN) === undefined
        ? {}
        : {
            accessToken: optionalText(environment.KAGUYA_NAPCAT_ACCESS_TOKEN),
          }),
      ...(optionalText(environment.KAGUYA_NAPCAT_SELF_ID) === undefined
        ? {}
        : { selfId: optionalText(environment.KAGUYA_NAPCAT_SELF_ID) }),
      reconnectMs: integerEnvironmentValue(
        environment.KAGUYA_NAPCAT_RECONNECT_MS,
        3000,
        100,
        3_600_000,
        "KAGUYA_NAPCAT_RECONNECT_MS",
      ),
    },
  };
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function integerEnvironmentValue(
  raw: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const normalized = optionalText(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  const value = Number(normalized);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
```

- [ ] **Step 4: Run config tests**

Run:

```bash
pnpm vitest run apps/bot/src/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Implement WebSocket JSON transport**

Create `apps/bot/src/server.ts`:

```ts
import { pathToFileURL } from "node:url";

import {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type JsonMessageTransport,
} from "@kaguya/platform-adapters";

import { readBotConfig } from "./config.js";
import { PlatformDispatcher } from "./dispatcher.js";

export class WebSocketJsonTransport implements JsonMessageTransport {
  private messageHandler: ((message: unknown) => void) | undefined;
  private closeHandler: ((error?: Error) => void) | undefined;
  private readonly socket: WebSocket;

  constructor(url: string, accessToken?: string) {
    this.socket = new WebSocket(withAccessToken(url, accessToken));
    this.socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data) {
        return;
      }
      this.messageHandler?.(JSON.parse(data));
    });
    this.socket.addEventListener("close", () => {
      this.closeHandler?.();
    });
    this.socket.addEventListener("error", () => {
      this.closeHandler?.(new Error("NapCat WebSocket error"));
    });
  }

  sendJson(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  onJsonMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.socket.close();
  }
}

export async function startBot(): Promise<void> {
  const config = readBotConfig();
  if (!config.napcat.enabled) {
    const dispatcher = PlatformDispatcher.createForDeterministicModel({
      databasePath: config.databasePath,
    });
    process.once("SIGINT", () => dispatcher.close());
    process.once("SIGTERM", () => dispatcher.close());
    return;
  }

  const transport = new WebSocketJsonTransport(
    config.napcat.wsUrl ?? "",
    config.napcat.accessToken,
  );
  const actionClient = new NapCatActionClient({
    adapterId: config.napcat.adapterId,
    transport,
    nextEcho: createEchoFactory(),
    timeoutMs: 30_000,
  });
  const dispatcher = PlatformDispatcher.createForDeterministicModel({
    databasePath: config.databasePath,
    platformReplySender: actionClient,
  });
  const adapter = new NapCatOneBotAdapter({
    adapterId: config.napcat.adapterId,
    transport,
    now: () => new Date(),
    onInboundMessage: (message) => dispatcher.dispatchInboundMessage(message),
  });
  await adapter.start();

  const close = async () => {
    await adapter.stop();
    dispatcher.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function withAccessToken(url: string, accessToken?: string): string {
  if (accessToken === undefined) {
    return url;
  }
  const parsed = new URL(url);
  parsed.searchParams.set("access_token", accessToken);
  return parsed.toString();
}

function createEchoFactory(): () => string {
  let sequence = 0;
  return () => `napcat-${Date.now()}-${++sequence}`;
}

if (process.argv[1] !== undefined) {
  const entrypointUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entrypointUrl) {
    await startBot();
  }
}
```

- [ ] **Step 6: Add root scripts**

Modify root `package.json` scripts:

```json
"bot": "pnpm --filter @kaguya/bot start",
"bot:dev": "pnpm --filter @kaguya/bot dev"
```

- [ ] **Step 7: Run app tests and typecheck**

Run:

```bash
pnpm vitest run apps/bot/src/config.test.ts apps/bot/src/dispatcher.test.ts
pnpm --filter @kaguya/bot typecheck
```

Expected: PASS.

- [ ] **Step 8: Run workspace verification**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add package.json apps/bot
git commit -m "feat: wire napcat bot runtime"
```

---

## Self-Review

Spec coverage:

- Adapter package: Tasks 1 and 2 create `@kaguya/platform-adapters`.
- OneBot inbound mapping: Task 1 covers private, group, ignored, and degraded segments.
- OneBot outbound actions: Tasks 1 and 2 cover request building and receipts.
- Production dispatcher: Task 4 creates `apps/bot` dispatcher over the existing workflow.
- Workflow sender port: Task 3 adds optional sender behavior while preserving local demo.
- Runtime configuration: Task 5 reads required bot and NapCat environment variables.
- Verification: Tasks 1-5 include package tests, app tests, `pnpm test`, and `pnpm typecheck`.

Placeholder scan:

- No intentionally incomplete implementation steps remain.
- No broad "handle errors" steps remain; error behavior is specified through concrete tests or code paths.

Type consistency:

- `PlatformReplySender.sendTextReply(target, text, metadata?)` is defined in Task 1 and consumed by Tasks 3-5.
- `PlatformDispatcher.createForDeterministicModel()` is defined in Task 4 and consumed by Task 5.
- `JsonMessageTransport` is defined in Task 2 and consumed by Task 5.
