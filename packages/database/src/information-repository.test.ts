/**
 * 功能概述：本文件是 information ledger 共享契约的 PGlite 注册入口。
 * 主要职责：以 `createTestingDatabase` 为 factory 注册全部账本读写、引用和 outbox
 * 行为测试；不在此处定义断言，避免 PGlite 与真实 PostgreSQL 的行为期望漂移。
 * 代码库关系：`information-ledger.contract.ts` 承载后端无关的测试；
 * `postgres-information-ledger.test.ts` 以真实 PostgreSQL factory 注册同一份契约。
 * 输入输出与副作用：每个契约用例自行创建、迁移和关闭独立测试数据库。
 */
import { defineInformationLedgerContract } from "./information-ledger.contract.js";
import { createTestingDatabase } from "./testing.js";

defineInformationLedgerContract({
  name: "information repository (PGlite)",
  createDatabase: createTestingDatabase,
});
