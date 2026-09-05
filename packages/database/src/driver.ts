/**
 * 功能概述：本模块提供生产 PostgreSQL 的数据库访问抽象与 `pg` 适配器，
 * 让仓储层只依赖统一的 query / transaction / exec 语义。
 * 主要职责：`PgDatabase.connect` 管理真实连接池（可传入 PostgreSQL startup options）；
 * `PgTransaction` 适配事务 client，并确保业务失败优先于尽力回滚的失败。
 * 代码库关系：`information-repository.ts` 与 `migrations.ts` 只面向这里的
 * `SqlDatabase`/`SqlTransaction` 端口；`index.ts` 用它建立生产连接；PGlite 测试驱动
 * 位于只由 `testing.ts` 加载的 `pglite-driver.ts`，因此生产入口不解析 dev-only 依赖。
 * 输入输出与副作用：方法接收 SQL 与参数并异步返回 rows/rowCount；连接、事务与关闭
 * 会改变底层 PostgreSQL 资源状态，失败保留原始业务异常。
 */
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
    readonly startupOptions?: string;
  }): Promise<PgDatabase> {
    return new PgDatabase(
      new Pool({
        connectionString: options.connectionString,
        options: options.startupOptions,
      }),
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
