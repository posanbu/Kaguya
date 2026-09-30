import { afterEach, describe, expect, it } from "vitest";
import { freezeInformationAtom, type JsonObject } from "@kaguya/schema";
import type { RawScope } from "@kaguya/memory";
import { PostgresRawEventStore } from "./raw-event-store.js";
import { createTestingDatabase } from "./testing.js";
const scope = {
  platform: "qq",
  adapterId: "main",
  destination: { kind: "private" as const, userId: "u" },
};
const other = {
  platform: "qq",
  adapterId: "main",
  destination: { kind: "group" as const, groupId: "g" },
};
const at = "2026-09-01T12:00:00.000Z";
const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});
async function setup() {
  const db = await createTestingDatabase();
  databases.push(db);
  await db.prepareSchema();
  await db.information.synchronizeKinds([
    "core.message.inbound.text",
    "filter.decision",
    "agent.router.turn.context.completed",
  ]);
  const add = async (
    id: string,
    kind: string,
    payload: JsonObject,
    refs: { relation: string; informationId: string }[] = [],
    time = at,
  ) => {
    await db.information.append(
      freezeInformationAtom({
        informationId: id,
        kind,
        payload,
        occurredAt: time,
        source: "test",
        references: refs,
      }),
      refs.length
        ? [
            {
              relation: "core:caused-by",
              targetKinds: ["core.message.inbound.text"],
              required: true,
              multiple: false,
            },
          ]
        : [],
    );
  };
  return { db, add };
}
const message = (text: string, target: RawScope = scope) => ({
  text,
  source: { ...target, senderId: "u", platformMessageId: `native-${text}` },
});
const read = (
  memory: PostgresRawEventStore,
  turnInformationId: string,
  unreadInformationIds: string[] = [],
) =>
  memory.freeze({ turnInformationId, asOf: at, scope, unreadInformationIds });

describe("raw event projection and two-block freeze", () => {
  it("backfills in registration order, resumes after restart and excludes rejected inbound", async () => {
    const { db, add } = await setup();
    await add("in-1", "core.message.inbound.text", message("first"));
    await add("cross", "core.message.inbound.text", message("cross", other));
    await add("turn-1", "agent.router.turn.context.completed", {});
    const memory = db.rawEvents;
    const first = await read(memory, "turn-1", ["in-1"]);
    expect(first.global.text).toContain("cross");
    expect(first.currentScope.text).toContain("【未读】");
    expect(first.currentScope.text).not.toContain("cross");
    expect(first.characterCount).toBe(
      Array.from(first.global.text + first.currentScope.text).length,
    );
    expect(await read(memory, "turn-1", ["in-1"])).toEqual(first);
    expect(
      (
        await db.sql.query(
          "SELECT count(*)::int AS count FROM memory_raw_events",
        )
      ).rows[0],
    ).toEqual({ count: 2 });
    await add("rejected", "core.message.inbound.text", message("blocked"));
    await add("filter", "filter.decision", { accepted: false }, [
      { relation: "core:caused-by", informationId: "rejected" },
    ]);
    await add("turn-2", "agent.router.turn.context.completed", {});
    const restarted = new PostgresRawEventStore(db.sql);
    const second = await read(restarted, "turn-2");
    expect(second.global.text).not.toContain("blocked");
    expect(second.currentScope.text).not.toContain("blocked");
    expect(
      (await read(restarted, "turn-2", ["rejected"])).currentScope.text,
    ).not.toContain("blocked");
    expect(await read(restarted, "turn-1", ["in-1"])).toEqual(first);
    expect(
      (await db.sql.query("SELECT position FROM memory_raw_checkpoint"))
        .rows[0],
    ).toMatchObject({ position: expect.anything() });
  });
  it("protects 30 previous scope events and unread originals beyond the character target", async () => {
    const { db, add } = await setup();
    for (let index = 0; index < 35; index++)
      await add(
        `old-${index}`,
        "core.message.inbound.text",
        message(`old-${index}-${"x".repeat(1100)}`),
        [],
        "2026-09-01T11:00:00.000Z",
      );
    await add(
      "unread",
      "core.message.inbound.text",
      message("unread-original"),
    );
    await add("turn", "agent.router.turn.context.completed", {});
    const frozen = await read(db.rawEvents, "turn", ["unread"]);
    expect(frozen.currentScope.text).toContain("old-34-");
    expect(frozen.currentScope.text).not.toContain("old-0-");
    expect(frozen.currentScope.text).toContain("【未读】");
    expect(frozen.currentScope.text).toContain("unread-original");
    expect(frozen.overBudget).toBe(true);
  });
  it("pages past unrenderable older events to keep the last 30 usable descriptions", async () => {
    const { db, add } = await setup();
    await add(
      "valid-old",
      "core.message.inbound.text",
      message("usable"),
      [],
      "2026-09-01T11:00:00.000Z",
    );
    for (let index = 0; index < 300; index++) {
      await add(
        `invalid-${index}`,
        "core.message.inbound.text",
        { text: "missing sender", source: scope },
        [],
        "2026-09-01T11:00:00.000Z",
      );
    }
    await add("turn", "agent.router.turn.context.completed", {});
    expect((await read(db.rawEvents, "turn")).currentScope.text).toContain(
      "usable",
    );
  });
  it("pages recent global and scope windows past unrenderable events", async () => {
    const { db, add } = await setup();
    await add(
      "valid-recent",
      "core.message.inbound.text",
      message("recent-usable"),
    );
    for (let index = 0; index < 1000; index++) {
      await add(`invalid-recent-${index}`, "core.message.inbound.text", {
        text: "missing sender",
        source: scope,
      });
    }
    await add("turn", "agent.router.turn.context.completed", {});
    const frozen = await read(db.rawEvents, "turn");
    expect(frozen.global.text).toContain("recent-usable");
    expect(frozen.currentScope.text).toContain("recent-usable");
  });
});
