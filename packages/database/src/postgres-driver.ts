/**
 * 架构说明：本模块提供数据库访问抽象与两种 PostgreSQL 执行器，
 * 让仓储层只依赖统一的 query / transaction / exec 语义，而不直接依赖
 * `pg` 的 Pool 或 PGlite 的 WASM 细节。
 * 代码库关系：`information-repository.ts` 与 `postgres-migrations.ts` 只面向这里的
 * `SqlDatabase`/`SqlTransaction` 端口；`testing.ts` 用 `PGliteDatabase` 构造隔离测试库，
 * `index.ts` 的 staged 公共入口则通过 `PgDatabase` 连接真实 PostgreSQL。
 */
import { PGlite, type PGliteInterface, type Transaction as PGliteTransaction } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";

export interface SqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
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
  transaction<Result>(run: (tx: SqlTransaction) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

export class PgDatabase implements SqlDatabase {
  constructor(private readonly pool: Pool) {}

  static async connect(options: { readonly connectionString: string }): Promise<PgDatabase> {
    return new PgDatabase(new Pool({ connectionString: options.connectionString }));
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    const result = await this.pool.query<Row>(text, values === undefined ? undefined : [...values]);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<Result>(run: (tx: SqlTransaction) => Promise<Result>): Promise<Result> {
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
      rowCount: typeof result.rowCount === "number" ? result.rowCount : result.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.database.exec(sql);
  }

  async transaction<Result>(run: (tx: SqlTransaction) => Promise<Result>): Promise<Result> {
    return this.database.transaction(async (tx) => run(new PGliteTransactionAdapter(tx)));
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
  constructor(
    private readonly transaction: PGliteTransaction,
  ) {}

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
      rowCount: typeof result.rowCount === "number" ? result.rowCount : result.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.transaction.exec(sql);
  }
}
