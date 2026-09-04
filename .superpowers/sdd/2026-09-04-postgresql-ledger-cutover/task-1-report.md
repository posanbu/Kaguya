# Task 1：统一 PGlite 与 PostgreSQL 的 ledger contract

## 实现

信息账本行为现在由 `defineInformationLedgerContract({ name, createDatabase })` 集中定义。PGlite 的 `information-repository.test.ts` 与真实服务的 `postgres-information-ledger.test.ts` 分别只注册各自的 factory，因此读取排序、引用验证、事务回滚和 outbox 语义不会再有两份会逐渐漂移的断言。

共享契约覆盖 kind 集合同步、JSONB 往返、ID 冲突、同 ID 并发 append、缺失目标/错误 kind/未声明 relation/重复单值 relation/缺失 required relation 的整笔回滚、引用顺序、反向引用排序、`getMany` 调用方顺序、atom 与 outbox 的同事务写入、失败计数、成功投递状态，以及并发 drain 不重复投递。

生产 `driver.ts` 仅保留 `pg` 的 SQL 抽象和真实事务实现。PGlite 适配器移至只由 `testing.ts` 导入的 `pglite-driver.ts`。`createPostgresTestingDatabase(connectionString)` 为每个数据库生成仅含小写字母、数字和下划线的 schema 名；管理 pool 创建和删除 schema，测试 pool 以 startup `search_path` 使用该 schema。关闭时依次关闭测试 pool、`DROP SCHEMA ... CASCADE`、关闭管理 pool；factory 建立期间的连接失败也会触发同一清理路径，且错误文本不包含连接串。

根 `pnpm test:postgres` 通过现有 `cross-env` 设置 `KAGUYA_REQUIRE_POSTGRES_TESTS=1`。普通测试在未配置 URL 时跳过真实服务套件；强制命令在 URL 缺失时以明确错误失败。

## 文件

- 新增 `packages/database/src/information-ledger.contract.ts`
- 新增 `packages/database/src/postgres-information-ledger.test.ts`
- 新增 `packages/database/src/pglite-driver.ts`
- 调整 `information-repository.test.ts`、`postgres-index.test.ts`、`driver.ts`、`testing.ts` 与根 `package.json`

`packages/database/package.json`、`packages/database/tsconfig.json` 和 `pnpm-lock.yaml` 未改动：PGlite 已在基线中是 database 包的 devDependency，现有 TypeScript 配置已经编译测试入口，新增脚本未引入新依赖。

## RED 与 GREEN 证据

RED：

```text
pnpm vitest run packages/database/src/information-repository.test.ts packages/database/src/postgres-information-ledger.test.ts
2 failed suites: defineInformationLedgerContract is not implemented
```

该失败来自尚未实现的共享 contract 接口，而非语法或模块解析错误。

GREEN：

```text
pnpm vitest run packages/database/src/information-repository.test.ts packages/database/src/postgres-index.test.ts
2 passed, 22 passed

KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres pnpm test:postgres
1 passed, 21 passed

pnpm --filter @kaguya/database typecheck
exit 0

pnpm typecheck
exit 0
```

额外检查：未设置 `KAGUYA_TEST_DATABASE_URL` 时 `pnpm test:postgres` 以 “KAGUYA_TEST_DATABASE_URL is required when PostgreSQL contract tests are required” 退出；`git diff --check` 通过；生产 `driver.ts` 和 `index.ts` 中没有 `@electric-sql/pglite` 导入。

## 自审与关注点

我检查了 schema 标识符的生成约束、pool 关闭顺序、factory 失败清理、错误字符串与连接串隔离，以及生产导入边界。真实 PostgreSQL 契约使用临时服务 `127.0.0.1:54329` 已验证。唯一的运行前提是 `test:postgres` 需要调用方提供一个有 `CREATE SCHEMA`/`DROP SCHEMA` 权限的 PostgreSQL URL；这是隔离和清理所必需的权限。

## 修复轮 1：补足真实索引、引用顺序和 outbox 回滚覆盖

审查指出三处测试边界缺口。本轮将真实 PostgreSQL 的索引检查加入 `postgres-index.test.ts`，并将其纳入 `test:postgres`：测试查询实际测试 schema 的 `pg_indexes`，确认 kind/time、source/time、反向引用和 pending outbox 的索引定义。原有的 PGlite migration append-only 触发器检查保持不变。

共享 ledger contract 的引用恢复用例现在写入两个相同 `core:contexts` relation，目标 ID 故意按 `atom-reference-z`、`atom-reference-a` 的非排序顺序追加，并逐项断言读回顺序相同。outbox 用例则在 `information_log_outbox` 上安装真实 `BEFORE INSERT` 触发器并强制异常，验证事务最终既没有 atom 也没有 outbox 行；不依赖 mock 调用计数。

测试先行记录如下。最初运行：

```text
pnpm vitest run packages/database/src/information-repository.test.ts packages/database/src/postgres-index.test.ts
1 failed: outbox INSERT 触发器异常被仓储归一化为 “information repository operation failed”，
而初始测试错误地要求底层异常文本。

KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres pnpm test:postgres
1 failed: bind message supplies 3 parameters, but prepared statement requires 1
```

前者改为断言稳定公共 `InformationStoreError`；后者把三个表名作为一个 `text[]` 参数传入。GREEN 命令与输出：

```text
pnpm vitest run packages/database/src/information-repository.test.ts packages/database/src/postgres-index.test.ts
2 passed, 23 passed, 1 skipped

KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres pnpm test:postgres
2 passed, 25 passed

pnpm --filter @kaguya/database typecheck
exit 0

pnpm typecheck
exit 0
```

覆盖文件为 `packages/database/src/information-repository.test.ts`（注册 PGlite contract）、`packages/database/src/postgres-information-ledger.test.ts`（注册真实 ledger contract）、`packages/database/src/information-ledger.contract.ts`（共享行为）与 `packages/database/src/postgres-index.test.ts`（真实 PostgreSQL 索引）。本轮未实现 close/reconnect recovery；该生命周期场景依照既定计划保留给 Task 2。
