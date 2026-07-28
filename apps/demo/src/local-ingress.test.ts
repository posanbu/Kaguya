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
});
