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
      expect(messages.find((message) => message.role === "user")).toMatchObject(
        {
          content: "Is the moon bright tonight?",
          metadata: {
            requestId: "request-abc",
            eventId: "webui-request-abc-message-received",
            traceId: "webui-request-abc",
          },
        },
      );
      expect(
        messages.find((message) => message.role === "assistant"),
      ).toMatchObject({
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

  it("dispatches multiple Web UI messages without exhausting deterministic LLM responses", async () => {
    const databasePath = tempDatabasePath();
    const ingress = createLocalMessageIngress({
      databasePath,
      now: () => new Date("2026-07-28T01:02:03.000Z"),
    });

    await ingress.enqueue({
      sessionId: "web-session-repeat",
      text: "First message",
      requestId: "request-one",
    });
    await ingress.enqueue({
      sessionId: "web-session-repeat",
      text: "Second message",
      requestId: "request-two",
    });
    ingress.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      const messages = database.messages.listRecent("web-session-repeat", 10);

      expect(messages.filter((message) => message.role === "user")).toHaveLength(
        2,
      );
      expect(
        messages.filter((message) => message.role === "assistant"),
      ).toHaveLength(2);
      expect(database.llmTraces.listByTrace("webui-request-one")).toHaveLength(
        2,
      );
      expect(database.llmTraces.listByTrace("webui-request-two")).toHaveLength(
        2,
      );
    } finally {
      database.close();
    }
  });

  it("keeps workflow record IDs unique after reopening the same local database", async () => {
    const databasePath = tempDatabasePath();
    const firstIngress = createLocalMessageIngress({
      databasePath,
      now: () => new Date("2026-07-28T01:02:03.000Z"),
    });
    await firstIngress.enqueue({
      sessionId: "web-session-restart",
      text: "Before restart",
      requestId: "request-before-restart",
    });
    firstIngress.close();

    const secondIngress = createLocalMessageIngress({
      databasePath,
      now: () => new Date("2026-07-28T01:03:03.000Z"),
    });
    await secondIngress.enqueue({
      sessionId: "web-session-restart",
      text: "After restart",
      requestId: "request-after-restart",
    });
    secondIngress.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      expect(database.messages.listRecent("web-session-restart", 10)).toHaveLength(
        4,
      );
      expect(
        database.eventRuns.listByTrace("webui-request-before-restart").length,
      ).toBeGreaterThan(0);
      expect(
        database.eventRuns.listByTrace("webui-request-after-restart").length,
      ).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });
});
