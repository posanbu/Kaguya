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
      expect(messages.find((message) => message.role === "user")).toMatchObject({
        content: "hello from qq",
        metadata: {
          adapterId: "napcat.qq.main",
          platform: "qq",
          platformMessageId: "12345",
          target: { kind: "private", userId: "112233" },
          sender: { userId: "112233", nickname: "Ada" },
        },
      });
      expect(sent).toEqual([
        {
          target: { kind: "private", userId: "112233" },
          text: "It is a lovely night for watching the moon.",
        },
      ]);
      expect(database.llmTraces.listByTrace("napcat:998877:12345")).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
