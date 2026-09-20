/**
 * 功能概述：本文件是 information ledger 共享契约的真实 PostgreSQL 注册入口。
 * 主要职责：读取测试连接串、在要求集成测试时拒绝缺失配置，并确认服务器版本后以真实
 * PostgreSQL factory 注册共享契约；普通测试运行可跳过这一外部服务依赖。
 * Web 投递分页用例以事务 barrier 与真实 advisory lock 等待，验证注册位置不会越过同会话未提交回执。
 * 代码库关系：依赖 `testing.ts` 将连接隔离到临时 schema，并将断言委托给
 * `information-ledger.contract.ts`；根 `test:postgres` 脚本设置强制执行模式。
 * 输入输出与副作用：测试会创建并清理临时 PostgreSQL schema；连接串不会写入错误消息。
 */
import { describe, expect, it, vi } from "vitest";

import { freezeInformationAtom, informationIdSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

import { defineInformationLedgerContract } from "./information-ledger.contract.js";
import {
  InformationLogProjectionRunner,
  InformationRepository,
} from "./index.js";
import type { SqlDatabase } from "./driver.js";
import * as testing from "./testing.js";

const connectionString = process.env.KAGUYA_TEST_DATABASE_URL;
const requirePostgres = process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1";

if (requirePostgres && connectionString === undefined) {
  throw new Error(
    "KAGUYA_TEST_DATABASE_URL is required when PostgreSQL contract tests are required",
  );
}

const describePostgres =
  connectionString === undefined ? describe.skip : describe;
const createPostgresTestingDatabase = testing.createPostgresTestingDatabase;
const restartKind = defineInformationKind({
  kind: "core.runtime.restart",
  displayName: "Core Runtime Restart",
  description: "Information carried by the core.runtime.restart kind.",
  payloadSchema: z.object({ name: z.string() }).strict(),
  references: {},
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "core.runtime.restart" }),
  },
});

describePostgres("information repository (PostgreSQL)", () => {
  it("connects to a real PostgreSQL server", async () => {
    const database = await createPostgresTestingDatabase(connectionString!);
    try {
      const result = await database.sql.query<{ server_version: string }>(
        "SHOW server_version",
      );
      expect(result.rows[0]?.server_version).toBeTruthy();
    } finally {
      await database.close();
    }
  });

  it("serializes Web delivery commits before a history cursor can pass them", async () => {
    const database = await createPostgresTestingDatabase(connectionString!);
    const allocated = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secondTransaction = Promise.withResolvers<number>();
    let started = 0;
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    let secondFinished = false;
    try {
      await database.prepareSchema();
      await database.information.synchronizeKinds(["core.delivery.delivered"]);
      const guarded: SqlDatabase = {
        query: (sql, values) => database.sql.query(sql, values),
        exec: (sql) => database.sql.exec(sql),
        close: async () => {},
        transaction: (run) =>
          database.sql.transaction(async (tx) => {
            const transactionNumber = ++started;
            if (transactionNumber === 2) {
              const result = await tx.query<{ pid: number }>(
                "SELECT pg_backend_pid() AS pid",
              );
              secondTransaction.resolve(result.rows[0]!.pid);
            }
            return run({
              exec: (sql) => tx.exec(sql),
              query: async <Row extends Record<string, unknown>>(
                sql: string,
                values?: readonly unknown[],
              ) => {
                const result = await tx.query<Row>(sql, values);
                if (
                  transactionNumber === 1 &&
                  sql.includes("INSERT INTO information_lifecycle")
                ) {
                  allocated.resolve();
                  await release.promise;
                }
                return result;
              },
            });
          }),
      };
      const repository = new InformationRepository(guarded);
      const target = {
        kind: "web",
        conversationId: "a879c96e-afdd-4716-9b86-8d15d264907f",
      };
      const delivered = (id: string) =>
        freezeInformationAtom({
          informationId: informationIdSchema.parse(id),
          kind: "core.delivery.delivered",
          occurredAt: "2026-09-19T00:00:00.000Z",
          source: "runtime:delivery",
          payload: {
            platform: "web",
            adapterId: "web.ui.main",
            target,
            ok: true,
          },
          references: [],
        });
      first = repository.append(delivered("first-web-delivery"), []);
      await Promise.race([allocated.promise, first]);
      second = repository
        .append(delivered("second-web-delivery"), [])
        .finally(() => {
          secondFinished = true;
        });
      const secondPid = await Promise.race([
        secondTransaction.promise,
        second.then(() => {
          throw new Error(
            "Second delivery completed before its transaction was observed",
          );
        }),
      ]);
      await vi.waitFor(
        async () => {
          expect(secondFinished).toBe(false);
          const locks = await database.sql.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting",
            [secondPid],
          );
          expect(locks.rows[0]?.waiting).toBe(true);
        },
        { timeout: 8000, interval: 20 },
      );

      const query = {
        kinds: ["core.delivery.delivered"],
        registrationOrder: true,
        payloadContains: { platform: "web", adapterId: "web.ui.main", target },
        limit: 10,
      };
      expect(await database.information.find(query)).toEqual([]);
      release.resolve();
      await Promise.all([first, second]);
      const visible = await database.information.find(query);
      expect(visible.map((atom) => atom.informationId)).toEqual([
        "first-web-delivery",
        "second-web-delivery",
      ]);
      expect(
        (
          await database.information.find({
            ...query,
            afterInformationId: visible[0]!.informationId,
          })
        ).map((atom) => atom.informationId),
      ).toEqual(["second-web-delivery"]);
    } finally {
      release.resolve();
      await Promise.allSettled(
        [first, second].filter((pending) => pending !== undefined),
      );
      await database.close();
    }
  }, 15_000);

  it("retains an atom and pending log projection after reconnecting its schema", async () => {
    const scope = await testing.createPostgresTestingDatabaseScope(
      connectionString!,
    );
    let firstConnection: Awaited<ReturnType<typeof scope.connect>> | undefined;
    try {
      firstConnection = await scope.connect();
      await firstConnection.prepareSchema();
      await firstConnection.information.synchronizeKinds([restartKind.kind]);
      const atom = freezeInformationAtom({
        informationId: informationIdSchema.parse("atom-restart-recovery"),
        kind: restartKind.kind,
        occurredAt: "2026-09-04T00:00:00.000Z",
        source: "module:test",
        payload: { name: "restart" },
        references: [],
      });
      await firstConnection.information.append(atom, [], {
        enqueueLogProjection: true,
      });

      await firstConnection.close();
      firstConnection = undefined;

      const reconnected = await scope.reconnect();
      try {
        expect(await reconnected.information.get(atom.informationId)).toEqual(
          atom,
        );
        expect(
          await reconnected.information.listPendingLogProjections(10),
        ).toEqual([{ informationId: atom.informationId, attemptCount: 0 }]);

        const projected: string[] = [];
        const runner = new InformationLogProjectionRunner({
          repository: reconnected.information,
          sink: async (projectedAtom) => {
            projected.push(projectedAtom.informationId);
          },
        });
        await runner.projectPending();

        expect(projected).toEqual([atom.informationId]);
        expect(
          await reconnected.information.listPendingLogProjections(10),
        ).toEqual([]);
      } finally {
        await reconnected.close();
      }
    } finally {
      await firstConnection?.close();
      await scope.close();
    }
  });

  it("does not lose a pool when connect and reconnect overlap", async () => {
    const scope = await testing.createPostgresTestingDatabaseScope(
      connectionString!,
    );
    let databases: Awaited<ReturnType<typeof scope.connect>>[] = [];
    try {
      const results = await Promise.allSettled([
        scope.connect(),
        scope.reconnect(),
      ]);
      databases = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );

      expect(databases).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);

      await scope.close();
      await expect(databases[0]!.sql.query("SELECT 1")).rejects.toThrow();
    } finally {
      await Promise.allSettled(databases.map((database) => database.close()));
      await scope.close();
    }
  });

  it("does not return a usable pool when its scope closes while opening", async () => {
    const scope = await testing.createPostgresTestingDatabaseScope(
      connectionString!,
    );
    let database: Awaited<ReturnType<typeof scope.connect>> | undefined;
    try {
      const opening = scope.connect().then(
        (opened) => ({ database: opened }),
        () => ({ database: undefined }),
      );
      await scope.close();
      ({ database } = await opening);

      expect(database).toBeUndefined();
      await expect(scope.connect()).rejects.toThrow(
        "PostgreSQL testing scope is already closed",
      );
    } finally {
      await database?.close();
      await scope.close();
    }
  });

  defineInformationLedgerContract({
    name: "information ledger contract (PostgreSQL)",
    createDatabase: () => createPostgresTestingDatabase(connectionString!),
  });
});
