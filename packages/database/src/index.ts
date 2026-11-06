/**
 * mediaSources 独立于 Memory 保存来源权限与请求快照；prepareSchema 同时准备其附加表。
 * inspection-reader 提供跨领域只读快照查询，不调用运行或恢复端口。
 * nativeTools 保存工具循环预算、dispatch 和调用映射；迁移在行动表之后初始化。
 * memoryGraph 暴露三字段节点与有向类型边的独立 PostgreSQL 存储。
 * 功能概述：提供 Kaguya 唯一的 PostgreSQL 信息账本入口，组合驱动、schema 准备与
 * append-only `InformationRepository`。
 * inspectMemoryVectors 只读可选索引的分页元数据，不安装扩展或暴露向量正文。
 * 主要职责：`KaguyaDatabase.connect` 创建真实 PostgreSQL 连接；构造函数支持测试注入
 * `SqlDatabase`；`prepareSchema` 初始化空 schema 或验证完整 v1；`close` 释放底层连接。
 * 代码库关系：Runtime 通过本入口连接或注入数据库；`testing.ts` 使用 PGlite 构造同一
 * `KaguyaDatabase`；Engine 只依赖仓储实现的 `InformationLedger` 端口。
 * 输入输出与副作用：连接、schema 准备、查询和关闭均为异步数据库 I/O；公开 `sql` 供包级
 * 集成测试与运维边界使用，不再创建 SQLite 文件或旧消息/运行记录仓储。
 * observations 组合持久场景、冻结清单和消费者进度；prepareSchema 在基础账本后执行幂等附加迁移。
 */
import {
  PostgresMediaSourceStore,
  prepareMediaSourceSchema,
} from "./media-source-store.js";
export { PostgresMediaResourceStore } from "./media-resource-store.js";
export { PostgresMediaSourceStore } from "./media-source-store.js";
import { prepareNativeMemoryToolSchema } from "./native-memory-tools.js";
export {
  NativeMemoryTools,
  nativeMemoryToolSchemas,
} from "./native-memory-tools.js";
import {
  PostgresNativeToolStore,
  prepareNativeToolSchema,
} from "./native-tool-store.js";
export {
  PostgresNativeToolStore,
  type NativeToolRunRow,
  type NativeToolCallRow,
} from "./native-tool-store.js";
import { PostgresObservationStore } from "./observation-store.js";
import { prepareObservationSchema } from "./observation-schema.js";
import { PostgresActionStore, prepareActionSchema } from "./action-store.js";
export {
  PostgresActionStore,
  actionDigest,
  actionBasisDigest,
  actionExecutionDigest,
  type ActionAuthorization,
  type ActionClaim,
} from "./action-store.js";
import { PgDatabase, type SqlDatabase } from "./driver.js";
export { PgDatabase, type SqlDatabase } from "./driver.js";
import { InformationRepository } from "./information-repository.js";
import { PostgresMemoryGraphStore } from "./memory-graph.js";
import { PostgresRawEventStore } from "./raw-event-store.js";
import { prepareDatabaseSchema } from "./schema.js";
import { ModelRequestMetricsRepository } from "./model-request-metrics.js";
export {
  INFORMATION_PROTOCOL_VERSION,
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
  InformationKindContractConflictError,
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
export { PostgresRawEventStore } from "./raw-event-store.js";
export { PostgresMemoryGraphStore } from "./memory-graph.js";
export {
  PostgresNativeMemoryStore,
  NativeMemoryError,
} from "./native-memory.js";

export class KaguyaDatabase {
  readonly mediaSources: PostgresMediaSourceStore;
  readonly actions: PostgresActionStore;
  readonly nativeTools: PostgresNativeToolStore;
  readonly observations: PostgresObservationStore;
  readonly information: InformationRepository;
  readonly memoryGraph: PostgresMemoryGraphStore;
  readonly rawEvents: PostgresRawEventStore;
  readonly modelRequestMetrics: ModelRequestMetricsRepository;

  constructor(readonly sql: SqlDatabase) {
    this.mediaSources = new PostgresMediaSourceStore(sql);
    this.actions = new PostgresActionStore(sql);
    this.nativeTools = new PostgresNativeToolStore(sql);
    this.observations = new PostgresObservationStore(sql);
    this.information = new InformationRepository(sql);
    this.memoryGraph = new PostgresMemoryGraphStore(sql);
    this.rawEvents = new PostgresRawEventStore(sql);
    this.modelRequestMetrics = new ModelRequestMetricsRepository(sql);
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
    await prepareMediaSourceSchema(this.sql);
    await prepareObservationSchema(this.sql);
    await prepareActionSchema(this.sql);
    await prepareNativeToolSchema(this.sql);
    await prepareNativeMemoryToolSchema(this.sql);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

export { ModelRequestMetricsRepository } from "./model-request-metrics.js";

export { PostgresNativeVectorRetriever } from "./native-memory-vector.js";

export { PostgresObservationStore } from "./observation-store.js";

export * from "./inspection-reader.js";
