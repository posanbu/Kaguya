import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { KaguyaDatabase } from "@kaguya/database";
import {
  createDeferredDeterministicModel,
  createRepeatingDeterministicModel,
} from "@kaguya/llm/testing";
import { createLogger } from "@kaguya/logger";
import type {
  PlatformDeliveryReceipt,
  PlatformMessageTarget,
  PlatformReplySender,
} from "@kaguya/platform-adapters";
import { afterEach, describe, expect, it } from "vitest";

import { KaguyaRuntime, RuntimeUnavailableError } from "./runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "kaguya-runtime-"));
  roots.push(root);
  return join(root, "kaguya.sqlite");
}

describe("KaguyaRuntime", () => {
  it("shares one database and workflow across Web and platform ingress", async () => {
    const databasePath = tempDatabasePath();
    const output = new PassThrough();
    let logs = "";
    output.on("data", (chunk) => {
      logs += chunk.toString();
    });
    const logger = createLogger({ service: "kaguya-test", stream: output });
    const sent: Array<{ target: PlatformMessageTarget; text: string }> = [];
    const sender: PlatformReplySender = {
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
    const runtime = new KaguyaRuntime({ databasePath, logger });
    await runtime.start();

    const webResult = await runtime.dispatch({
      kind: "web",
      requestId: "request-shared-1",
      sessionId: "shared-session",
      text: "Hello from Web",
    });
    const platformResult = await runtime.dispatch({
      kind: "platform",
      replySender: sender,
      message: {
        platform: "qq",
        adapterId: "napcat.qq.main",
        selfId: "998877",
        sessionId: "shared-session",
        traceId: "napcat:998877:message-1",
        platformMessageId: "message-1",
        occurredAt: "2026-08-11T00:00:00.000Z",
        text: "Hello from QQ",
        target: { kind: "private", userId: "112233" },
        sender: { userId: "112233", nickname: "Ada" },
        raw: { access_token: "must-not-be-persisted" },
      },
    });
    await runtime.close();

    expect(webResult).toMatchObject({
      traceId: "webui-request-shared-1",
      interrupted: false,
    });
    expect(webResult.delivery).toBeUndefined();
    expect(platformResult.delivery).toMatchObject({ ok: true });
    expect(logs).toContain("platform.delivery.completed");
    expect(logs).not.toContain("112233");
    expect(logs).not.toContain("must-not-be-persisted");
    expect(logs).not.toContain("Hello from Web");
    expect(logs).not.toContain("Hello from QQ");
    expect(sent).toEqual([
      {
        target: { kind: "private", userId: "112233" },
        text: "It is a lovely night for watching the moon.",
      },
    ]);

    const database = KaguyaDatabase.open(databasePath);
    try {
      expect(database.messages.listRecent("shared-session", 10)).toHaveLength(
        4,
      );
      expect(
        JSON.stringify(database.messages.listRecent("shared-session", 10)),
      ).not.toContain("must-not-be-persisted");
      const workflowIds = [
        ...database.eventRuns.listByTrace("webui-request-shared-1"),
        ...database.eventRuns.listByTrace("napcat:998877:message-1"),
      ].map((run) => run.workflowId);
      expect(new Set(workflowIds)).toEqual(new Set(["message-workflow"]));
      expect(database.memories.listRecent("shared-session", 10)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("uses a repeatable deterministic model for multiple messages", async () => {
    const databasePath = tempDatabasePath();
    const runtime = new KaguyaRuntime({ databasePath });
    await runtime.start();

    await Promise.all([
      runtime.dispatch({
        kind: "web",
        requestId: "request-a",
        sessionId: "session-a",
        text: "First",
      }),
      runtime.dispatch({
        kind: "web",
        requestId: "request-b",
        sessionId: "session-b",
        text: "Second",
      }),
    ]);
    await runtime.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      expect(database.llmTraces.listByTrace("webui-request-a")).toHaveLength(2);
      expect(database.llmTraces.listByTrace("webui-request-b")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("keeps concurrent trace contexts isolated in runtime logs", async () => {
    const output = new PassThrough();
    let logs = "";
    output.on("data", (chunk) => {
      logs += chunk.toString();
    });
    const logger = createLogger({
      service: "kaguya-test",
      level: "debug",
      stream: output,
    });
    const runtime = new KaguyaRuntime({
      databasePath: tempDatabasePath(),
      logger,
    });
    await runtime.start();
    await Promise.all([
      runtime.dispatch({
        kind: "web",
        requestId: "context-a",
        sessionId: "session-a",
        text: "A",
      }),
      runtime.dispatch({
        kind: "web",
        requestId: "context-b",
        sessionId: "session-b",
        text: "B",
      }),
    ]);
    await runtime.close();

    const entries = logs
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const completions = entries.filter(
      (entry) => entry.event === "message.dispatch.completed",
    );
    expect(completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          traceId: "webui-context-a",
          sessionId: "session-a",
        }),
        expect.objectContaining({
          traceId: "webui-context-b",
          sessionId: "session-b",
        }),
      ]),
    );
    expect(entries.some((entry) => entry.event === "event.emitted")).toBe(true);
    expect(
      entries.some((entry) => entry.event === "workflow.node.completed"),
    ).toBe(true);
  });

  it("closes idempotently and rejects later dispatches", async () => {
    const runtime = new KaguyaRuntime({ databasePath: tempDatabasePath() });
    await runtime.start();
    await Promise.all([runtime.close(), runtime.close()]);

    await expect(
      runtime.dispatch({
        kind: "web",
        requestId: "after-close",
        sessionId: "session",
        text: "Must fail",
      }),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);
  });

  it("stops accepting work and waits for an in-flight dispatch before close", async () => {
    const route = createDeferredDeterministicModel({
      shouldReply: true,
      reason: "continue after close begins",
    });
    const runtime = new KaguyaRuntime({
      databasePath: tempDatabasePath(),
      resolveModel(request) {
        return request.kind === "route"
          ? route.model
          : createRepeatingDeterministicModel({
              text: "The in-flight reply completed.",
            });
      },
    });
    await runtime.start();
    const dispatch = runtime.dispatch({
      kind: "web",
      requestId: "in-flight",
      sessionId: "session-in-flight",
      text: "Wait for me",
    });
    await route.started;

    let closed = false;
    const close = runtime.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(
      runtime.dispatch({
        kind: "web",
        requestId: "rejected-while-closing",
        sessionId: "session-rejected",
        text: "Must not start",
      }),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);

    route.release();
    await expect(dispatch).resolves.toMatchObject({ interrupted: false });
    await close;
    expect(closed).toBe(true);
    await runtime.close();
  });
});
