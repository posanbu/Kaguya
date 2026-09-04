/**
 * 功能概述：本文件是 information ledger 共享契约的真实 PostgreSQL 注册入口。
 * 主要职责：读取测试连接串、在要求集成测试时拒绝缺失配置，并确认服务器版本后以真实
 * PostgreSQL factory 注册共享契约；普通测试运行可跳过这一外部服务依赖。
 * 代码库关系：依赖 `testing.ts` 将连接隔离到临时 schema，并将断言委托给
 * `information-ledger.contract.ts`；根 `test:postgres` 脚本设置强制执行模式。
 * 输入输出与副作用：测试会创建并清理临时 PostgreSQL schema；连接串不会写入错误消息。
 */
import { describe, expect, it } from "vitest";

import { freezeInformationAtom, informationIdSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

import { defineInformationLedgerContract } from "./information-ledger.contract.js";
import { InformationLogProjectionRunner } from "./index.js";
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

  it("retains an atom and pending log projection after reconnecting its schema", async () => {
    const scope = await testing.createPostgresTestingDatabaseScope(
      connectionString!,
    );
    let firstConnection: Awaited<ReturnType<typeof scope.connect>> | undefined;
    try {
      firstConnection = await scope.connect();
      await firstConnection.migrate();
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
