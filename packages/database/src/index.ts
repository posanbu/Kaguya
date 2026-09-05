/**
 * 功能概述：提供 Kaguya 唯一的 PostgreSQL 信息账本入口，组合驱动、迁移与
 * append-only `InformationRepository`。
 * 主要职责：`KaguyaDatabase.connect` 创建真实 PostgreSQL 连接；构造函数支持测试注入
 * `SqlDatabase`；`migrate` 建立原子、引用和日志 outbox；`close` 释放底层连接。
 * 代码库关系：Runtime 通过本入口连接或注入数据库；`testing.ts` 使用 PGlite 构造同一
 * `KaguyaDatabase`；Engine 只依赖仓储实现的 `InformationLedger` 端口。
 * 输入输出与副作用：连接、迁移、查询和关闭均为异步数据库 I/O；公开 `sql` 供包级
 * 集成测试与运维边界使用，不再创建 SQLite 文件或旧消息/运行记录仓储。
 */
import { PgDatabase, type SqlDatabase } from "./driver.js";
import { InformationRepository } from "./information-repository.js";
import { migrateDatabase } from "./migrations.js";

export {
  InformationIdConflictError,
  InformationKindSetMismatchError,
  InformationRepository,
  InformationStoreError,
  InvalidInformationReferenceError,
  type PendingInformationLogProjection,
} from "./information-repository.js";
export {
  InformationLogProjectionRunner,
  type InformationAtomLogSink,
  type InformationLogProjectionFailure,
  type InformationLogProjectionRunnerOptions,
} from "./information-log-projection.js";

export class KaguyaDatabase {
  readonly information: InformationRepository;

  constructor(readonly sql: SqlDatabase) {
    this.information = new InformationRepository(sql);
  }

  static async connect(options: {
    readonly connectionString: string;
  }): Promise<KaguyaDatabase> {
    return new KaguyaDatabase(
      await PgDatabase.connect({ connectionString: options.connectionString }),
    );
  }

  async migrate(): Promise<void> {
    await migrateDatabase(this.sql);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
