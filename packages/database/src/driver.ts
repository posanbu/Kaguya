/**
 * 功能概述：本模块提供数据库访问抽象与两种 PostgreSQL 执行器，
 * 让仓储层只依赖统一的 query / transaction / exec 语义，而不直接依赖
 * `pg` 的 Pool 或 PGlite 的 WASM 细节。
 * 主要职责：`PgDatabase.connect` 管理真实连接池；`PGliteDatabase.create` 创建内存库；
 * 两个实现都适配 query、批量 exec、事务回滚和 close，内部 adapter 约束事务句柄。
 * 代码库关系：`information-repository.ts` 与 `migrations.ts` 只面向这里的
 * `SqlDatabase`/`SqlTransaction` 端口；`testing.ts` 用 `PGliteDatabase` 构造隔离测试库，
 * `index.ts` 的最终 `KaguyaDatabase` 入口则通过 `PgDatabase` 连接真实 PostgreSQL。
 * 输入输出与副作用：方法接收 SQL 与参数并异步返回 rows/rowCount；连接、事务与关闭
 * 会改变底层数据库资源状态，失败时保留原始异常，回滚失败不会覆盖业务失败。
 */
import {
  PGlite,
  type PGliteInterface,
  type Transaction as PGliteTransaction,
} from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";

export interface SqlResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface SqlTransaction {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  exec(sql: string): Promise<void>;
}

export interface SqlDatabase extends SqlTransaction {
  exec(sql: string): Promise<void>;
  transaction<Result>(
    run: (tx: SqlTransaction) => Promise<Result>,
  ): Promise<Result>;
  close(): Promise<void>;
}

export class PgDatabase implements SqlDatabase {
  constructor(private readonly pool: Pool) {}

  static async connect(options: {
    readonly connectionString: string;
  }): Promise<PgDatabase> {
    return new PgDatabase(
      new Pool({ connectionString: options.connectionString }),
    );
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    const result = await this.pool.query<Row>(
      text,
      values === undefined ? undefined : [...values],
    );
    return {
      rows: result.rows,
      rowCount: result.rowCount,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<Result>(
    run: (tx: SqlTransaction) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(new PgTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (cause) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original failure is the signal the caller needs; rollback best-effort only.
      }
      throw cause;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class PGliteDatabase implements SqlDatabase {
  constructor(private readonly database: PGliteInterface) {}

  static async create(): Promise<PGliteDatabase> {
    return new PGliteDatabase(await PGlite.create());
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    const result = await this.database.query<Row>(
      text,
      values === undefined ? undefined : [...values],
    );
    return {
      rows: result.rows,
      rowCount:
        typeof result.rowCount === "number"
          ? result.rowCount
          : result.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.database.exec(sql);
  }

  async transaction<Result>(
    run: (tx: SqlTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database.transaction(async (tx) =>
      run(new PGliteTransactionAdapter(tx)),
    );
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}

class PgTransaction implements SqlTransaction {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    const result = await this.client.query<Row>(
      text,
      values === undefined ? undefined : [...values],
    );
    return {
      rows: result.rows,
      rowCount: result.rowCount,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }
}

class PGliteTransactionAdapter implements SqlTransaction {
  constructor(private readonly transaction: PGliteTransaction) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    const result = await this.transaction.query<Row>(
      text,
      values === undefined ? undefined : [...values],
    );
    return {
      rows: result.rows,
      rowCount:
        typeof result.rowCount === "number"
          ? result.rowCount
          : result.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.transaction.exec(sql);
  }
}
