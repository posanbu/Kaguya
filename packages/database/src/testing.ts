/**
 * 架构说明：本模块为 database 包及其消费者的集成测试提供两种隔离的 `KaguyaDatabase`：
 * 内存 PGlite，以及真实 PostgreSQL 的临时 schema。
 * 主要职责：`createTestingDatabase` 创建 PGlite；`createPostgresTestingDatabase` 与
 * `createPostgresTestingDatabaseScope` 生成安全的 schema 名，用管理连接创建/销毁 schema，
 * 并以 PostgreSQL startup options 固定测试连接的 search_path。scope 允许在最终清理前关闭和
 * 重连 pool；两者都不自动迁移。
 * 代码库关系：PGlite 适配器位于 `pglite-driver.ts`；生产 `driver.ts` 提供 `PgDatabase`；
 * PostgreSQL ledger contract 仅通过本模块获得真实服务 factory，调用方仍只使用 `KaguyaDatabase`。
 * 输入输出与副作用：每次 factory 都分配独立数据库空间，调用方负责 migrate 和 close；
 * schema scope 的最终 close 先关闭测试 pool，再 DROP SCHEMA CASCADE 并关闭管理连接，创建
 * 失败亦清理；单次连接 close 不会重建或清空 schema。
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
  const scope = await createPostgresTestingDatabaseScope(connectionString);
  try {
    const database = await scope.connect();
    return new KaguyaDatabase(
      new ScopeFinalizingPostgresDatabase(database.sql, scope),
    );
  } catch (cause) {
    try {
      await scope.close();
    } catch {
      // Preserve the connection failure that made this factory unusable.
    }
    throw new Error(
      "Unable to create an isolated PostgreSQL testing database",
      { cause },
    );
  }
}

export interface PostgresTestingDatabaseScope {
  /** Opens the first pool attached to this isolated schema. */
  connect(): Promise<KaguyaDatabase>;
  /** Opens a replacement pool after the prior connection has been closed. */
  reconnect(): Promise<KaguyaDatabase>;
  /** Closes any active pool and drops the isolated schema exactly once. */
  close(): Promise<void>;
}

export async function createPostgresTestingDatabaseScope(
  connectionString: string,
): Promise<PostgresTestingDatabaseScope> {
  const schema = `kaguya_test_${randomUUID().replaceAll("-", "")}`;
  let management: Pool | undefined;

  try {
    management = new Pool({ connectionString });
    await management.query(`CREATE SCHEMA ${schema}`);
    return new SchemaIsolatedPostgresTestingScope(
      connectionString,
      management,
      schema,
    );
  } catch (cause) {
    await closePartiallyCreatedPostgresDatabase({
      management,
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

class SchemaIsolatedPostgresTestingScope implements PostgresTestingDatabaseScope {
  #closed = false;
  #connection: SchemaIsolatedPostgresConnection | undefined;

  constructor(
    private readonly connectionString: string,
    private readonly management: Pool,
    private readonly schema: string,
  ) {}

  connect(): Promise<KaguyaDatabase> {
    return this.openConnection();
  }

  reconnect(): Promise<KaguyaDatabase> {
    return this.openConnection();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    let failure: unknown;
    try {
      await this.#connection?.close();
    } catch (cause) {
      failure = cause;
    }
    try {
      await this.management.query(
        `DROP SCHEMA IF EXISTS ${this.schema} CASCADE`,
      );
    } catch (cause) {
      failure ??= cause;
    }
    try {
      await this.management.end();
    } catch (cause) {
      failure ??= cause;
    }
    if (failure !== undefined) throw failure;
  }

  async release(connection: SchemaIsolatedPostgresConnection): Promise<void> {
    if (this.#connection === connection) {
      this.#connection = undefined;
    }
  }

  private async openConnection(): Promise<KaguyaDatabase> {
    if (this.#closed) {
      throw new Error("PostgreSQL testing scope is already closed");
    }
    if (this.#connection !== undefined) {
      throw new Error(
        "PostgreSQL testing scope must close its current connection before reconnecting",
      );
    }

    const testing = await PgDatabase.connect({
      connectionString: this.connectionString,
      startupOptions: `-c search_path=${this.schema}`,
    });
    const connection = new SchemaIsolatedPostgresConnection(testing, this);
    this.#connection = connection;
    try {
      await testing.query("SELECT 1");
      return new KaguyaDatabase(connection);
    } catch (cause) {
      await connection.close();
      throw cause;
    }
  }
}

class SchemaIsolatedPostgresConnection implements SqlDatabase {
  #closed = false;

  constructor(
    private readonly testing: PgDatabase,
    private readonly scope: SchemaIsolatedPostgresTestingScope,
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
    try {
      await this.testing.close();
    } finally {
      await this.scope.release(this);
    }
  }
}

class ScopeFinalizingPostgresDatabase implements SqlDatabase {
  constructor(
    private readonly database: SqlDatabase,
    private readonly scope: PostgresTestingDatabaseScope,
  ) {}

  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    return this.database.query(text, values);
  }

  exec(sql: string): Promise<void> {
    return this.database.exec(sql);
  }

  transaction<Result>(
    run: (tx: SqlTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database.transaction(run);
  }

  close(): Promise<void> {
    return this.scope.close();
  }
}

async function closePartiallyCreatedPostgresDatabase(options: {
  readonly management: Pool | undefined;
  readonly schema: string;
}): Promise<void> {
  let failure: unknown;
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
