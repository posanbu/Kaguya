/**
 * 架构说明：本模块只服务于数据库包自身测试，提供一个隔离的内存 PGlite
 * 实例以及它上面的 staged PostgreSQL 数据库，避免测试依赖真实外部数据库。
 * 代码库关系：测试套件和 Runtime 注入测试直接导入 `createTestingDatabase()`；它返回
 * 真实 `PostgresKaguyaDatabase`，同时可通过公开 `sql` 句柄执行断言所需的原始 SQL。
 * 输入输出与副作用：每次调用创建独立 PGlite；调用方负责 migrate 与 close，返回对象
 * 可直接满足 `KaguyaRuntimeOptions.database`，不再用缺少类身份的平行测试接口包装。
 */
import { PostgresKaguyaDatabase } from "./index.js";
import { PGliteDatabase } from "./postgres-driver.js";

export async function createTestingDatabase(): Promise<PostgresKaguyaDatabase> {
  const sql = await PGliteDatabase.create();
  return new PostgresKaguyaDatabase(sql);
}
