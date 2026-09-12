/**
 * 功能概述：提供 Kaguya 唯一的 PostgreSQL 信息账本入口，组合驱动、schema 准备与
 * append-only `InformationRepository`。
 * 额外导出可选 PostgresMemoryVectorIndex，启用流程由宿主显式执行而不影响 sparse-only schema。
 * 主要职责：`KaguyaDatabase.connect` 创建真实 PostgreSQL 连接；构造函数支持测试注入
 * `SqlDatabase`；`prepareSchema` 初始化空 schema 或验证完整 v1；`close` 释放底层连接。
 * 代码库关系：Runtime 通过本入口连接或注入数据库；`testing.ts` 使用 PGlite 构造同一
 * `KaguyaDatabase`；Engine 只依赖仓储实现的 `InformationLedger` 端口。
 * 输入输出与副作用：连接、schema 准备、查询和关闭均为异步数据库 I/O；公开 `sql` 供包级
 * 集成测试与运维边界使用，不再创建 SQLite 文件或旧消息/运行记录仓储。
 */
import { PgDatabase, type SqlDatabase } from "./driver.js";
import { InformationRepository } from "./information-repository.js";
import { PostgresMemoryStore } from "./memory-store.js";
import { prepareDatabaseSchema } from "./schema.js";
export {
  POSTGRES_SCHEMA_VERSION,
  UnsupportedDatabaseSchemaError,
} from "./schema.js";

export const SUPPORTED_POSTGRES_MAJOR = 17;

export class UnsupportedPostgresVersionError extends Error {
  constructor(
    readonly expectedMajor: number,
    readonly actualMajor: number,
  ) {
    super("Unsupported PostgreSQL major version");
    this.name = "UnsupportedPostgresVersionError";
  }
}

export async function assertSupportedPostgresVersion(
  database: Pick<SqlDatabase, "query">,
): Promise<void> {
  const result = await database.query<{ server_version_num: string }>(
    "SHOW server_version_num",
  );
  const rawVersion = result.rows[0]?.server_version_num;
  const versionNumber = Number.parseInt(rawVersion ?? "", 10);
  const actualMajor = Math.floor(versionNumber / 10_000);
  if (
    !Number.isInteger(actualMajor) ||
    actualMajor !== SUPPORTED_POSTGRES_MAJOR
  ) {
    throw new UnsupportedPostgresVersionError(
      SUPPORTED_POSTGRES_MAJOR,
      actualMajor,
    );
  }
}

export {
  InformationIdConflictError,
  InformationKindSetMismatchError,
  InformationRepository,
  InformationStoreError,
  InvalidInformationReferenceError,
  type PendingInformationLogProjection,
} from "./information-repository.js";
export {
  OneShotScheduleRepository,
  type OneShotScheduleProjectionStore,
  type OpenOneShotArm,
  type OpenOneShotPage,
} from "./one-shot-schedule-repository.js";
export {
  InformationLogProjectionRunner,
  type InformationAtomLogSink,
  type InformationLogProjectionFailure,
  type InformationLogProjectionBatchResult,
  type InformationLogProjectionRunnerOptions,
} from "./information-log-projection.js";
export {
  PostgresMemoryStore,
  type PostgresMemoryStoreOptions,
} from "./memory-store.js";

export class KaguyaDatabase {
  readonly information: InformationRepository;
  readonly memory: PostgresMemoryStore;

  constructor(readonly sql: SqlDatabase) {
    this.information = new InformationRepository(sql);
    this.memory = new PostgresMemoryStore(sql);
  }

  static async connect(options: {
    readonly connectionString: string;
  }): Promise<KaguyaDatabase> {
    const sql = await PgDatabase.connect({
      connectionString: options.connectionString,
    });
    try {
      await assertSupportedPostgresVersion(sql);
      return new KaguyaDatabase(sql);
    } catch (error) {
      try {
        await sql.close();
      } catch {
        // Preserve the compatibility or connection error that blocks startup.
      }
      throw error;
    }
  }

  async prepareSchema(): Promise<void> {
    await prepareDatabaseSchema(this.sql);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

export { PostgresMemoryVectorIndex } from "./memory-vector.js";
