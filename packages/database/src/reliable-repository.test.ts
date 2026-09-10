/**
 * 功能概述：以真实 PGlite 事务检验 Reliable DAG 的投递、幂等、终态与 lease fencing。
 * 主要职责：证明落账不会漏投、历史不会自动 backfill、重复产出只返回赢家，旧 claim 无写权限。
 * 代码库关系：直接使用生产 InformationRepository 与相同 v1 schema，避免内存替身隐藏事务错误。
 * 输入输出与副作用：每例创建独立数据库并清理；主动过期执行表 lease 模拟进程崩溃。
 */
import { afterEach, expect, it, vi } from "vitest";
import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";
import { createTestingDatabase } from "./testing.js";

const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});
async function setup() {
  const db = await createTestingDatabase();
  databases.push(db);
  await db.prepareSchema();
  await db.information.synchronizeKinds([
    "test.source",
    "test.output",
    "test.failed",
  ]);
  return db;
}
const atom = (id: string, kind = "test.source") =>
  freezeInformationAtom({
    informationId: informationIdSchema.parse(id),
    kind,
    occurredAt: new Date().toISOString(),
    source: "module:test",
    payload: { text: "sensitive" },
    references: [],
  });
const subscriptions = [{ subscriptionId: "test.consume", kind: "test.source" }];

it("commits delivery intent with source but never backfills subscription history", async () => {
  const db = await setup();
  await db.information.append(atom("old"), []);
  await db.information.reliable.configureSubscriptions(subscriptions);
  await db.information.append(atom("new"), []);
  const claim = await db.information.reliable.claim("test.consume", 10000);
  expect(claim?.informationId).toBe("new");
  expect(
    await db.information.reliable.claim("test.consume", 10000),
  ).toBeUndefined();
  expect(await db.information.reliable.ack(claim!)).toBe(true);
  expect((await db.information.reliable.health()).pending).toBe(0);
});

it("returns one operation winner and one cross-kind terminal under concurrent submissions", async () => {
  const db = await setup();
  const outputs = await Promise.all(
    ["a", "b"].map((id) =>
      db.information.reliable.appendOnce(
        "test.operation.v1",
        "source-fingerprint",
        atom(id, "test.output"),
        [],
        {},
      ),
    ),
  );
  expect(outputs[0]!.atom.informationId).toBe(outputs[1]!.atom.informationId);
  expect(outputs.filter((r) => r.created)).toHaveLength(1);
  await db.information.append(atom("subject"), []);
  const terminals = await Promise.all(
    ["test.output", "test.failed"].map((kind, i) =>
      db.information.reliable.appendTerminal(
        "test.terminal",
        informationIdSchema.parse("subject"),
        atom(`terminal-${i}`, kind),
        [],
        {},
      ),
    ),
  );
  expect(terminals[0]!.atom.informationId).toBe(
    terminals[1]!.atom.informationId,
  );
  expect(terminals.filter((r) => r.created)).toHaveLength(1);
});

it("fences expired claims from output and ack while permitting recovery", async () => {
  const db = await setup();
  await db.information.reliable.configureSubscriptions(subscriptions);
  await db.information.append(atom("recover"), []);
  const old = (await db.information.reliable.claim("test.consume", 10000))!;
  await db.sql.exec(
    "UPDATE information_deliveries SET lease_until = clock_timestamp() - interval '1 second'",
  );
  const current = (await db.information.reliable.claim("test.consume", 10000))!;
  expect(current.token).not.toBe(old.token);
  await expect(
    db.information.reliable.appendOnce(
      "test.work",
      "recover",
      atom("late", "test.output"),
      [],
      {},
      old,
    ),
  ).rejects.toThrow(/claim/i);
  expect(
    await db.information.get(informationIdSchema.parse("late")),
  ).toBeUndefined();
  expect(await db.information.reliable.ack(old)).toBe(false);
  expect(await db.information.reliable.ack(current)).toBe(true);
});

it("rolls back unique slot and delivery on invalid reference", async () => {
  const db = await setup();
  await db.information.reliable.configureSubscriptions(subscriptions);
  const invalid = freezeInformationAtom({
    ...atom("bad"),
    references: [
      {
        relation: "test:source",
        informationId: informationIdSchema.parse("missing"),
      },
    ],
  });
  await expect(
    db.information.reliable.appendOnce(
      "test.op",
      "key",
      invalid,
      [{ relation: "test:source", required: true, multiple: false }],
      {},
    ),
  ).rejects.toThrow();
  const output = await db.information.reliable.appendOnce(
    "test.op",
    "key",
    atom("good"),
    [],
    {},
  );
  expect(output.created).toBe(true);
  expect((await db.information.reliable.health()).pending).toBe(1);
});

it("keeps pending work when disabled and refuses changed subscription identity", async () => {
  const db = await setup();
  await db.information.reliable.configureSubscriptions(subscriptions);
  await db.information.append(atom("pending"), []);
  await db.information.reliable.configureSubscriptions([]);
  await db.information.append(atom("disabled"), []);
  expect(
    await db.information.reliable.claim("test.consume", 10000),
  ).toBeUndefined();
  await db.information.reliable.configureSubscriptions(subscriptions);
  expect(
    (await db.information.reliable.claim("test.consume", 10000))?.informationId,
  ).toBe("pending");
  await expect(
    db.information.reliable.configureSubscriptions([
      { subscriptionId: "test.consume", kind: "test.output" },
    ]),
  ).rejects.toThrow();
});

it("releases shutdown claims without retry cost and reports bounded failures without body", async () => {
  const db = await setup();
  await db.information.reliable.configureSubscriptions(subscriptions);
  await db.information.append(atom("retry"), []);
  const first = (await db.information.reliable.claim("test.consume", 10000))!;
  await db.information.reliable.release(first);
  const next = (await db.information.reliable.claim("test.consume", 10000))!;
  expect(next.attempt).toBe(first.attempt);
  await db.information.reliable.retry(next, 0);
  const health = await db.information.reliable.health();
  expect(health.retry).toBe(1);
  expect(health.pending).toBe(1);
  expect(JSON.stringify(health)).not.toContain("sensitive");
});

it("rolls back an in-progress guarded transaction when shutdown aborts before commit", async () => {
  const db = await setup();
  await db.information.reliable.configureSubscriptions(subscriptions);
  await db.information.append(atom("abort-source"), []);
  const claim = (await db.information.reliable.claim("test.consume", 10000))!;
  let entered = false;
  let resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  const transaction = db.sql.transaction.bind(db.sql);
  vi.spyOn(db.sql, "transaction").mockImplementation((run) =>
    transaction((tx) =>
      run({
        exec: (sql) => tx.exec(sql),
        query: async (text, values) => {
          const result = await tx.query(text, values);
          if (text.includes("INSERT INTO information_atoms")) {
            entered = true;
            await gate;
          }
          return result as never;
        },
      }),
    ),
  );
  const controller = new AbortController();
  const write = db.information.reliable.appendOnce(
    "test.aborted",
    "key",
    atom("aborted-output", "test.output"),
    [],
    {},
    { ...claim, signal: controller.signal },
  );
  await vi.waitFor(() => expect(entered).toBe(true));
  controller.abort();
  resume();
  await expect(write).rejects.toThrow();
  expect(
    await db.information.get(informationIdSchema.parse("aborted-output")),
  ).toBeUndefined();
});

it("rolls back exhaustion when shutdown aborts during its final delivery update", async () => {
  const db = await setup();
  await db.information.reliable.configureSubscriptions(subscriptions);
  await db.information.append(atom("exhaust-source"), []);
  const claim = (await db.information.reliable.claim("test.consume", 10000))!;
  let entered = false;
  let resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  const transaction = db.sql.transaction.bind(db.sql);
  vi.spyOn(db.sql, "transaction").mockImplementation((run) =>
    transaction((tx) =>
      run({
        exec: (sql) => tx.exec(sql),
        query: async (text, values) => {
          const result = await tx.query(text, values);
          if (text.includes("state='exhausted'")) {
            entered = true;
            await gate;
          }
          return result as never;
        },
      }),
    ),
  );
  const controller = new AbortController();
  const write = db.information.reliable.exhaust(
    { ...claim, signal: controller.signal },
    atom("exhaust-output", "test.failed"),
    [],
  );
  await vi.waitFor(() => expect(entered).toBe(true));
  controller.abort();
  resume();
  await expect(write).rejects.toThrow();
  expect(
    await db.information.get(informationIdSchema.parse("exhaust-output")),
  ).toBeUndefined();
  expect((await db.information.reliable.health()).exhausted).toBe(0);
});
