/**
 * 功能概述：本模块是 database 包测试专用的内存 PGlite `SqlDatabase` 适配器。
 * 主要职责：`PGliteDatabase.create` 建立独立内存库；query、exec、transaction 和 close
 * 将 PGlite API 归一到生产仓储使用的 SQL 端口，并把缺失 rowCount 规范为行数。
 * 代码库关系：只由 `testing.ts` 导入，复用 `driver.ts` 定义的接口；生产 `index.ts` 和
 * `driver.ts` 不导入本文件，令生产运行时不会加载 `@electric-sql/pglite`。
 * 输入输出与副作用：每次 create 分配一个新内存数据库；事务与关闭会改变其生命周期，
 * SQL 错误由底层 PGlite 原样传播。
 */
import {
  PGlite,
  type PGliteInterface,
  type Transaction as PGliteTransaction,
} from "@electric-sql/pglite";

import type { SqlDatabase, SqlResult, SqlTransaction } from "./driver.js";

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
