/**
 * 架构说明：本模块为 database 包及其消费者的集成测试提供两种隔离的 `KaguyaDatabase`：
 * 内存 PGlite，以及真实 PostgreSQL 的临时 schema。
 * 主要职责：`createTestingDatabase` 创建 PGlite；`createPostgresTestingDatabase` 生成安全的
 * schema 名，用管理连接创建/销毁 schema，并以 PostgreSQL startup options 固定测试连接的
 * search_path。两者都不自动迁移。
 * 代码库关系：PGlite 适配器位于 `pglite-driver.ts`；生产 `driver.ts` 提供 `PgDatabase`；
 * PostgreSQL ledger contract 仅通过本模块获得真实服务 factory，调用方仍只使用 `KaguyaDatabase`。
 * 输入输出与副作用：每次 factory 都分配独立数据库空间，调用方负责 migrate 和 close；
 * schema 数据库 close 先关闭测试 pool，再 DROP SCHEMA CASCADE 并关闭管理连接，创建失败亦清理。
 */
import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  PgDatabase,
  type SqlDatabase,
  type SqlResult,
  type SqlTransaction,
} from "./driver.js";
import { KaguyaDatabase } from "./index.js";
import { PGliteDatabase } from "./pglite-driver.js";

export async function createTestingDatabase(): Promise<KaguyaDatabase> {
  const sql = await PGliteDatabase.create();
  return new KaguyaDatabase(sql);
}

export async function createPostgresTestingDatabase(
  connectionString: string,
): Promise<KaguyaDatabase> {
  const schema = `kaguya_test_${randomUUID().replaceAll("-", "")}`;
  let management: Pool | undefined;
  let testing: PgDatabase | undefined;

  try {
    management = new Pool({ connectionString });
    await management.query(`CREATE SCHEMA ${schema}`);
    testing = await PgDatabase.connect({
      connectionString,
      startupOptions: `-c search_path=${schema}`,
    });
    await testing.query("SELECT 1");
    return new KaguyaDatabase(
      new SchemaIsolatedPostgresDatabase(testing, management, schema),
    );
  } catch (cause) {
    await closePartiallyCreatedPostgresDatabase({
      management,
      testing,
      schema,
    });
    throw new Error(
      "Unable to create an isolated PostgreSQL testing database",
      {
        cause,
      },
    );
  }
}

class SchemaIsolatedPostgresDatabase implements SqlDatabase {
  #closed = false;

  constructor(
    private readonly testing: PgDatabase,
    private readonly management: Pool,
    private readonly schema: string,
  ) {}

  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    return this.testing.query(text, values);
  }

  exec(sql: string): Promise<void> {
    return this.testing.exec(sql);
  }

  transaction<Result>(
    run: (tx: SqlTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.testing.transaction(run);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await closePartiallyCreatedPostgresDatabase({
      management: this.management,
      testing: this.testing,
      schema: this.schema,
    });
  }
}

async function closePartiallyCreatedPostgresDatabase(options: {
  readonly management: Pool | undefined;
  readonly testing: PgDatabase | undefined;
  readonly schema: string;
}): Promise<void> {
  let failure: unknown;
  try {
    await options.testing?.close();
  } catch (cause) {
    failure = cause;
  }
  try {
    await options.management?.query(
      `DROP SCHEMA IF EXISTS ${options.schema} CASCADE`,
    );
  } catch (cause) {
    failure ??= cause;
  }
  try {
    await options.management?.end();
  } catch (cause) {
    failure ??= cause;
  }
  if (failure !== undefined) throw failure;
}
