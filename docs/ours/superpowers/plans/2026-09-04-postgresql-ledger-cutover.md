# PostgreSQL 信息账本最终切换实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已经完成 #39、#40、#41 的信息 DAG 基线上，为 PostgreSQL 信息账本补齐真实服务契约测试与 CI 门禁，并删除最后的 SQLite 运行时痕迹。

**Architecture:** `KaguyaDatabase` 继续作为唯一生产数据库入口，生产驱动只依赖 `pg`。测试层把 ledger contract 抽成可复用套件，分别以 PGlite 和由 `KAGUYA_TEST_DATABASE_URL` 指向的真实 PostgreSQL 隔离 schema 执行；Runtime、Server 与 demo 只接受 `KAGUYA_DATABASE_URL` 或显式测试数据库注入。GitHub Actions 额外启动 PostgreSQL service，独立运行真实数据库集成测试。

**Tech Stack:** TypeScript 6 strict ESM、Node.js 24.18.0、pnpm 11.9.0、Vitest 4.1.10、`pg` 8、PGlite 0.5、PostgreSQL 17、GitHub Actions。

**Spec:** `docs/ours/superpowers/specs/2026-09-01-information-atom-contract-design.md`

## Global Constraints

- `KaguyaDatabase` 是唯一生产数据库入口；生产 Runtime 不得导入或加载 PGlite、SQLite adapter、`node:sqlite` 或 SQLite 文件路径。
- Server 与 demo 的生产连接配置只使用必填 `KAGUYA_DATABASE_URL`；`KAGUYA_DATABASE_PATH`、`KAGUYA_DEMO_DATABASE_PATH` 和 `databasePath` 不保留兼容读取或运行时分支。
- 不提供 SQLite 到 PostgreSQL 的导入、转换、合并或自动删除。
- 信息原子和有序引用只追加；payload 使用 `jsonb`；引用使用外键；原子 append 与可选日志投影 outbox 必须处于同一事务。
- PostgreSQL 测试必须覆盖事务回滚、并发 append、引用完整性、kind/time/reference 索引、outbox 投递状态和关闭连接后重新连接的恢复行为。
- 共享 ledger contract 必须由 PGlite 和真实 PostgreSQL 两个后端调用，不能复制两套断言。
- 真实 PostgreSQL 测试只使用 `KAGUYA_TEST_DATABASE_URL`，每个测试数据库实例使用唯一隔离 schema，并在关闭时清理；错误与日志不得回显连接串。
- 所有新建或修改的源码文件必须维护位于文件开头的中文架构注释；JSON、YAML、锁文件和生成物不添加伪注释。
- 保持 Node.js 24.18.0、pnpm 11.9.0 及现有 strict ESM、格式化、lint 约束。
- 完成标准是 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm test:postgres` 和文档构建全部通过。

### Task 1: 让同一套 ledger contract 在 PGlite 与真实 PostgreSQL 上运行

**Files:**

- Create: `packages/database/src/information-ledger.contract.ts`
- Create: `packages/database/src/postgres-information-ledger.test.ts`
- Modify: `packages/database/src/information-repository.test.ts`
- Modify: `packages/database/src/postgres-index.test.ts`
- Create: `packages/database/src/pglite-driver.ts`
- Modify: `packages/database/src/driver.ts`
- Modify: `packages/database/src/testing.ts`
- Modify: `packages/database/tsconfig.json`
- Modify: `packages/database/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `KaguyaDatabase`, `InformationRepository` 与当前 migration schema。
- Produces: `defineInformationLedgerContract(options)`，由两个 backend adapter 注册完全相同的行为测试。
- Produces: `createTestingDatabase()` 的现有 PGlite 行为，以及仅测试导出的 `createPostgresTestingDatabase(connectionString)`；后者通过唯一 schema 隔离并在 `close()` 时清理。
- Produces: 根脚本 `pnpm test:postgres`；缺少 `KAGUYA_TEST_DATABASE_URL` 时必须明确失败，不能把整套 PostgreSQL 契约静默跳过。

- [ ] **Step 1: 写出失败的共享 contract 与真实 PostgreSQL 入口测试**

从当前 `information-repository.test.ts` 提取 factory 参数，但先让 PGlite 与真实 PostgreSQL 测试文件都调用尚未实现的 `defineInformationLedgerContract`。真实测试入口读取 `KAGUYA_TEST_DATABASE_URL`，并断言实际服务器返回非空 `server_version`。

契约至少保留并覆盖下列行为：kind 集合同步、JSONB 往返、ID 冲突、两个相同 ID 的并发 append 仅一个成功、缺失目标/错误目标 kind/未声明 relation/重复单值 relation/缺失 required relation 的整笔回滚、有序引用恢复、反向引用稳定排序、`getMany` 调用方顺序、原子与 outbox 同事务、投影失败计数、成功投递状态以及并发 drain 不重复投递。

- [ ] **Step 2: 运行 RED 并记录预期失败**

Run: `pnpm vitest run packages/database/src/information-repository.test.ts packages/database/src/postgres-information-ledger.test.ts`

Expected: FAIL，因为共享 contract 与真实 PostgreSQL testing factory 尚不存在；失败必须来自缺少目标接口，而非语法或模块解析错误。

- [ ] **Step 3: 分离生产 `pg` 驱动与 PGlite 测试驱动**

`driver.ts` 只保留 `SqlResult`、`SqlTransaction`、`SqlDatabase`、`PgDatabase` 与真实事务实现。把 `PGliteDatabase` 和 adapter 移入 `pglite-driver.ts`，仅由 `testing.ts` 导入，确保安装生产依赖时不会加载 dev-only PGlite。

`createPostgresTestingDatabase(connectionString)` 使用 UUID 生成只含小写字母、数字和下划线的 schema 名；管理连接创建 schema，测试连接通过 PostgreSQL startup `options` 固定 `search_path`。返回的数据库在 `close()` 时先关闭测试 pool，再 `DROP SCHEMA ... CASCADE` 并关闭管理连接；创建中途失败也必须清理已经取得的资源。不得把用户提供的连接串写入错误消息。

- [ ] **Step 4: 实现一次定义、两个后端的 contract**

把数据库行为断言移动到 `information-ledger.contract.ts` 的 `defineInformationLedgerContract({ name, createDatabase })`。`information-repository.test.ts` 只用 `createTestingDatabase` 注册 PGlite 契约；`postgres-information-ledger.test.ts` 只在普通 `pnpm test` 中 skip，在 `pnpm test:postgres` 下要求 URL 并用 `createPostgresTestingDatabase` 注册相同契约。

根脚本通过一个明确的测试模式环境变量区分“普通测试可跳过”和“集成命令必须执行”，例如 `KAGUYA_REQUIRE_POSTGRES_TESTS=1`。脚本必须使用现有 `cross-env`，保持命令在支持的 shell 上可运行。

- [ ] **Step 5: 验证 GREEN**

Run: `pnpm vitest run packages/database/src/information-repository.test.ts packages/database/src/postgres-index.test.ts`

Expected: PASS，PGlite 契约与 migration 测试保持绿色。

Run with a live service: `KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres pnpm test:postgres`

Expected: PASS，输出明确包含真实 PostgreSQL 契约，不出现 skipped suite。

- [ ] **Step 6: 验证类型与提交**

Run: `pnpm --filter @kaguya/database typecheck`

Run: `pnpm typecheck`

Expected: PASS。

```bash
git add package.json pnpm-lock.yaml packages/database
git commit -m "test(database): run ledger contract against postgres"
```

### Task 2: 补齐重启恢复并清除 SQLite 运行时残留

**Files:**

- Modify: `packages/database/src/postgres-information-ledger.test.ts`
- Modify: `scripts/information-architecture.test.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/config.test.ts`
- Modify: `apps/server/src/server-composition.test.ts`
- Modify if scan proves necessary: production TypeScript under `packages/` or `apps/`

**Interfaces:**

- Consumes: Task 1 的真实 PostgreSQL schema scope 与连接工厂。
- Produces: 关闭第一个 `KaguyaDatabase` pool 后重新连接同一隔离 schema 的测试能力，最终仍由 scope 清理 schema。
- Produces: 静态架构门禁，禁止生产 TypeScript 出现 `node:sqlite`、`DatabaseSync`、`.sqlite`、`databasePath`、`KAGUYA_DATABASE_PATH` 与 `KAGUYA_DEMO_DATABASE_PATH`。

- [ ] **Step 1: 写出失败的真实重启恢复测试与源码门禁**

在真实 PostgreSQL 测试中：迁移并同步 kind，append 一个启用日志投影的原子，关闭第一个连接，重新连接同一 schema，再读取原子与 pending outbox；用重新创建的 `InformationLogProjectionRunner` 成功投递并断言 pending 为空。测试结束必须清理 schema。

扩展 `scripts/information-architecture.test.ts` 的 production source 规则，加入本任务列出的 SQLite 标识；保留 docs 与测试文件排除规则。

- [ ] **Step 2: 运行 RED 并确认残留位置**

Run: `pnpm vitest run scripts/information-architecture.test.ts apps/server/src/config.test.ts`

Expected: FAIL，至少命中 `apps/server/src/config.ts` 中仍保留的旧 `KAGUYA_DATABASE_PATH` 兼容拒绝分支。

Run with live service: `KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres pnpm test:postgres`

Expected: FAIL，因为 testing scope 尚不支持在清理前重新连接同一 schema。

- [ ] **Step 3: 实现重连生命周期并删除残留**

为 Task 1 的 PostgreSQL testing scope 增加显式 `connect()`/`reconnect()` 或等价窄接口：重连不得重建或清空 schema，最终 `close()` 才执行一次 cleanup。实现必须避免 pool 泄漏，且 cleanup 对测试失败路径同样有效。

从 Server 配置的 legacy variable 列表及测试中删除 `KAGUYA_DATABASE_PATH`，因为最终配置契约只认识 `KAGUYA_DATABASE_URL`。把 `server-composition.test.ts` 中仅作为临时目录锚点的 `kaguya.sqlite`/`databasePath` 命名改为 `root` 或 `workspaceRoot`，不创建数据库文件。

- [ ] **Step 4: 验证 GREEN 与文件系统行为**

Run: `pnpm vitest run scripts/information-architecture.test.ts apps/server/src/config.test.ts apps/server/src/server-composition.test.ts`

Expected: PASS。

Run with live service: `KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres pnpm test:postgres`

Expected: PASS，重连后 atom 与 outbox 仍存在且可以完成投影。

Run: `rg -n "node:sqlite|DatabaseSync|\\.sqlite|databasePath|KAGUYA_DATABASE_PATH|KAGUYA_DEMO_DATABASE_PATH" packages apps scripts --glob '*.ts' --glob '*.tsx' --glob '*.mjs' --glob '!*.test.ts' --glob '!*.test.tsx'`

Expected: no matches。

- [ ] **Step 5: 提交**

```bash
git add packages/database/src/postgres-information-ledger.test.ts packages/database/src/testing.ts scripts/information-architecture.test.ts apps/server/src/config.ts apps/server/src/config.test.ts apps/server/src/server-composition.test.ts
git commit -m "test(database): verify postgres restart recovery"
```

### Task 3: 将真实 PostgreSQL 验收接入 CI 并同步公开文档

**Files:**

- Modify: `.github/workflows/test.yml`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/developers/contributing.md`
- Modify: `docs/developers/architecture.md`
- Modify: `docs/developers/index.md`
- Modify: `docs/guide/index.md`
- Modify: `docs/guide/installation.md`
- Modify: `docs/reference/environment-variables.md`
- Modify: `docs/reference/index.md`
- Modify: `docs/project/index.md`
- Modify only when verification reveals a concrete defect: files covered by the failing check

**Interfaces:**

- Consumes: `pnpm test:postgres` 与必填 `KAGUYA_TEST_DATABASE_URL`。
- Produces: Linux PostgreSQL integration job；普通跨平台 test matrix 不依赖外部数据库。
- Produces: 与最终代码一致的 PostgreSQL 安装、配置、迁移、测试和“无 SQLite 导入”说明。

- [ ] **Step 1: 写 CI PostgreSQL service job**

在 `.github/workflows/test.yml` 增加独立 `postgres` job，使用 `ubuntu-latest` 与 `postgres:17-alpine` service。service 配置固定测试凭据、`pg_isready` health check、5432 端口；job 安装仓库锁定的 pnpm/Node，执行 frozen install、必要 workspace build，并以 job-level `KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres` 运行 `pnpm test:postgres`。不得把生产 `KAGUYA_DATABASE_URL` 或 secret 写进 workflow。

- [ ] **Step 2: 更新公开文档**

先阅读 `docs/developers/markdown-features.md`。删除把旧 SQLite 环境变量描述成仍由 Runtime 识别的文字；明确 Server/demo 需要 `KAGUYA_DATABASE_URL`、迁移在启动时事务执行、payload 为 JSONB、引用由外键保护、日志 outbox 与原子同事务、仓库 contract 在 PGlite 和 CI PostgreSQL 上共用，以及旧 SQLite 数据不会导入。

文档只更新已经由代码与测试交付的行为，不添加数据迁移命令，不把 `KAGUYA_TEST_DATABASE_URL` 描述为生产配置。

- [ ] **Step 3: 运行格式、文档与完整质量门禁**

Run: `pnpm format:check`

Run: `pnpm lint`

Run: `pnpm typecheck`

Run: `pnpm build`

Run: `pnpm test`

Run with live service: `KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres pnpm test:postgres`

Run: `pnpm --dir docs docs:build`

Expected: 全部 PASS；普通测试中真实 PostgreSQL suite 可以明确 skip，但 PostgreSQL 专用命令必须全部执行且通过。

- [ ] **Step 4: 最终验收审计并提交**

确认 migration 实际存在 `jsonb` payload、atom kind/time/source 索引、reference target/relation 索引、显式引用外键和 pending outbox 索引；确认 Runtime URL 分支调用 `KaguyaDatabase.connect`，不存在任何创建 SQLite 文件的调用。

```bash
git add .github/workflows/test.yml README.md CONTRIBUTING.md docs/developers docs/guide docs/reference docs/project
git commit -m "ci: verify postgres ledger integration"
```

