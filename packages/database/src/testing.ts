/**
 * 架构说明：本模块只服务于数据库包自身测试，提供一个隔离的内存 PGlite
 * 实例以及它上面的最终 PostgreSQL 数据库，避免测试依赖真实外部数据库。
 * 主要职责：`createTestingDatabase` 创建驱动并返回使用生产仓储与迁移逻辑的
 * `KaguyaDatabase`，不额外包装或自动迁移。
 * 代码库关系：本文件从同包 `driver.ts` 取得仅测试使用的 `PGliteDatabase`，并从
 * `index.ts` 取得生产公开的 `KaguyaDatabase`；测试套件和 Runtime 注入测试直接导入
 * `createTestingDatabase()`，同时可通过返回对象的公开 `sql` 句柄执行断言所需的原始 SQL。
 * 输入输出与副作用：每次调用创建独立 PGlite；调用方负责 migrate 与 close，返回对象
 * 可直接满足 `KaguyaRuntimeOptions.database`，不再用缺少类身份的平行测试接口包装。
 */
import { PGliteDatabase } from "./driver.js";
import { KaguyaDatabase } from "./index.js";

export async function createTestingDatabase(): Promise<KaguyaDatabase> {
  const sql = await PGliteDatabase.create();
  return new KaguyaDatabase(sql);
}
