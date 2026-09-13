/**
 * 功能概述：用真实 PostgreSQL 多连接与关闭重连验证 reliable 存储保证。
 * openScope 用 24 个真实连接请求与重新连接验证唯一开放候选及旧 wake 的稳定别名。
 * 主要职责：并发竞争唯一槽和 claim；重连后重投未 ack 输入，同时复用已提交输出。
 * 代码库关系：与 PGlite 使用同一 InformationRepository；testing scope 隔离并清理 schema。
 * 输入输出与副作用：需要测试连接串，只创建临时 schema，不修改业务数据库；不会输出连接凭据。
 */
import { describe, expect, it } from "vitest";
import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";
import { createPostgresTestingDatabaseScope } from "./testing.js";
const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL test URL required");
const atom = (id: string, kind = "test.source") =>
  freezeInformationAtom({
    informationId: informationIdSchema.parse(id),
    kind,
    occurredAt: new Date().toISOString(),
    source: "module:test",
    payload: {},
    references: [],
  });
describe.skipIf(!url)("PostgreSQL reliable execution", () => {
  it("serializes actual connection races for operations, terminal kinds and claims", async () => {
    const scope = await createPostgresTestingDatabaseScope(url!);
    try {
      const db = await scope.connect();
      await db.prepareSchema();
      await db.information.synchronizeKinds([
        "test.source",
        "test.output",
        "test.failed",
      ]);
      await db.information.reliable.configureSubscriptions([
        { subscriptionId: "test.consume", kind: "test.source" },
      ]);
      await db.information.append(atom("source"), []);
      const operations = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          db.information.reliable.appendOnce(
            "test.operation",
            "source",
            atom(`output-${i}`, "test.output"),
            [],
            {},
          ),
        ),
      );
      expect(new Set(operations.map((r) => r.atom.informationId)).size).toBe(1);
      expect(operations.filter((r) => r.created)).toHaveLength(1);
      const terminals = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          db.information.reliable.appendTerminal(
            "test.terminal",
            informationIdSchema.parse("source"),
            atom(`terminal-${i}`, i % 2 ? "test.failed" : "test.output"),
            [],
            {},
          ),
        ),
      );
      expect(new Set(terminals.map((r) => r.atom.informationId)).size).toBe(1);
      expect(terminals.filter((r) => r.created)).toHaveLength(1);
      const claims = await Promise.all(
        Array.from({ length: 12 }, () =>
          db.information.reliable.claim("test.consume", 10000),
        ),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
    } finally {
      await scope.close();
    }
  });
  it("recovers a committed output with no ack after closing the connection pool", async () => {
    const scope = await createPostgresTestingDatabaseScope(url!);
    try {
      const first = await scope.connect();
      await first.prepareSchema();
      await first.information.synchronizeKinds(["test.source", "test.output"]);
      const subscriptions = [
        { subscriptionId: "test.restart", kind: "test.source" },
      ];
      await first.information.reliable.configureSubscriptions(subscriptions);
      await first.information.append(atom("restart-source"), []);
      const old = (await first.information.reliable.claim(
        "test.restart",
        10000,
      ))!;
      const output = await first.information.reliable.appendOnce(
        "test.output",
        "restart-source",
        atom("committed", "test.output"),
        [],
        {},
        old,
      );
      await first.sql.exec(
        "UPDATE information_deliveries SET lease_until=clock_timestamp()-interval '1 second'",
      );
      await first.close();
      const second = await scope.reconnect();
      await second.information.reliable.configureSubscriptions(subscriptions);
      const recovered = (await second.information.reliable.claim(
        "test.restart",
        10000,
      ))!;
      expect(recovered.token).not.toBe(old.token);
      expect(recovered.informationId).toBe(old.informationId);
      const repeated = await second.information.reliable.appendOnce(
        "test.output",
        "restart-source",
        atom("duplicate", "test.output"),
        [],
        {},
        recovered,
      );
      expect(repeated.atom).toEqual(output.atom);
      expect(repeated.created).toBe(false);
      expect(await second.information.reliable.ack(old)).toBe(false);
      expect(await second.information.reliable.ack(recovered)).toBe(true);
      expect((await second.information.reliable.health()).pending).toBe(0);
    } finally {
      await scope.close();
    }
  });
  it("coalesces scoped candidates across connections and restart without replaying old wakes", async () => {
    const scope = await createPostgresTestingDatabaseScope(url!);
    try {
      const first = await scope.connect();
      await first.prepareSchema();
      await first.information.synchronizeKinds(["test.source", "test.output"]);
      const options = {
        openScope: { key: "chat", terminalGroup: "test.done" },
      };
      const winners = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          first.information.reliable.appendOnce(
            "test.observe",
            `wake-${i}`,
            atom(`candidate-${i}`, "test.output"),
            [],
            options,
          ),
        ),
      );
      expect(winners.filter((r) => r.created)).toHaveLength(1);
      const winner = winners[0]!.atom;
      expect(new Set(winners.map((r) => r.atom.informationId)).size).toBe(1);
      await first.close();
      const second = await scope.reconnect();
      await second.prepareSchema();
      const resumed = await second.information.reliable.appendOnce(
        "test.observe",
        "after-restart",
        atom("restarted", "test.output"),
        [],
        options,
      );
      expect(resumed.atom.informationId).toBe(winner.informationId);
      await second.information.reliable.appendTerminal(
        "test.done",
        winner.informationId,
        atom("finished"),
        [],
        {},
      );
      const next = await second.information.reliable.appendOnce(
        "test.observe",
        "next",
        atom("next", "test.output"),
        [],
        options,
      );
      expect(next.created).toBe(true);
      const old = await second.information.reliable.appendOnce(
        "test.observe",
        "wake-3",
        atom("replayed", "test.output"),
        [],
        options,
      );
      expect(old.atom.informationId).toBe(winner.informationId);
      expect(
        await second.information.find({
          kinds: ["test.output"],
          openOnly: true,
          limit: 10,
        }),
      ).toEqual([next.atom]);
    } finally {
      await scope.close();
    }
  });
});
