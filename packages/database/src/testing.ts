/**
 * 架构说明：本模块只服务于数据库包自身测试，提供一个隔离的内存 PGlite
 * 实例以及它上面的 staged PostgreSQL 仓储，避免测试依赖真实外部数据库。
 * 代码库关系：测试套件直接导入这里的 `createTestingDatabase()`；它内部组合
 * `PGliteDatabase`、`PostgresKaguyaDatabase` 与原始 `sql` 句柄，用于执行真实 SQL。
 */
import type { InformationRepository } from "./information-repository.js";
import { PostgresKaguyaDatabase } from "./index.js";
import { PGliteDatabase, type SqlDatabase } from "./postgres-driver.js";

export interface TestingPostgresDatabase {
  readonly sql: SqlDatabase;
  readonly information: InformationRepository;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestingDatabase(): Promise<TestingPostgresDatabase> {
  const sql = await PGliteDatabase.create();
  const database = new PostgresKaguyaDatabase(sql);
  return {
    sql,
    information: database.information,
    migrate: () => database.migrate(),
    close: () => database.close(),
  };
}
