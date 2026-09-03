/**
 * 架构说明：本入口同时暴露旧 SQLite 版数据库与 staged 的 PostgreSQL 版数据库，
 * 以便在 Task 6 完成旧入口清理前，已存在的调用方仍能继续编译和运行。
 * 代码库关系：旧的 `KaguyaDatabase` 继续使用 `node:sqlite` 与历史仓储实现；新增
 * 的 `PostgresKaguyaDatabase` 则组合 `postgres-driver`、`information-repository`
 * 与迁移模块，形成 Runtime 可注入或按 URL 连接的信息账本入口。
 * 输入输出与副作用：`PostgresKaguyaDatabase` 公开只读 `sql` 以支持 PGlite 集成测试，
 * `migrate/close` 均为异步；旧 `KaguyaDatabase` 仍暂存到后续清理任务。
 */
import { DatabaseSync } from "node:sqlite";

import { migrateDatabase } from "./migrations.js";
import {
  EventRunRepository,
  LlmTraceRepository,
  MessageRepository,
  OutboundMessageRepository,
} from "./repositories.js";
import { InformationRepository } from "./information-repository.js";
import { migratePostgresDatabase } from "./postgres-migrations.js";
import { PgDatabase, type SqlDatabase } from "./postgres-driver.js";

export { DatabaseFormatError } from "./migrations.js";
export {
  DatabaseRecordError,
  EventRunRepository,
  EventRunLifecycleError,
  LlmTraceRepository,
  MessageRepository,
  OutboundMessageRepository,
} from "./repositories.js";
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

export class PostgresKaguyaDatabase {
  readonly information: InformationRepository;

  constructor(readonly sql: SqlDatabase) {
    this.information = new InformationRepository(sql);
  }

  static async connect(options: {
    readonly connectionString: string;
  }): Promise<PostgresKaguyaDatabase> {
    return new PostgresKaguyaDatabase(
      await PgDatabase.connect({ connectionString: options.connectionString }),
    );
  }

  async migrate(): Promise<void> {
    await migratePostgresDatabase(this.sql);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

export class KaguyaDatabase {
  readonly messages: MessageRepository;
  readonly eventRuns: EventRunRepository;
  readonly llmTraces: LlmTraceRepository;
  readonly outboundMessages: OutboundMessageRepository;

  private constructor(private readonly database: DatabaseSync) {
    this.messages = new MessageRepository(database);
    this.eventRuns = new EventRunRepository(database);
    this.llmTraces = new LlmTraceRepository(database);
    this.outboundMessages = new OutboundMessageRepository(database);
  }

  static open(path: string): KaguyaDatabase {
    return new KaguyaDatabase(new DatabaseSync(path));
  }

  migrate(): void {
    migrateDatabase(this.database);
  }

  close(): void {
    this.database.close();
  }
}
