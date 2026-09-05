---
title: 参与贡献
description: Kaguya 开发环境、测试、包依赖和提交检查。
---

# 参与贡献

代码和文档应在同一变更中保持一致。功能与修复采用小步 RED、GREEN、REFACTOR，优先断言公开结果、已提交的信息原子或显式引用关系，而不是已删除的事件、会话或 trace 结构。

## 固定开发环境

仓库要求 Node.js 24.18.0、pnpm 11.9.0 和根 `pnpm-lock.yaml`。首次安装或切换包含公共导出变化的分支后，先执行完整构建。

::: code-group

```bash [准备依赖 ~vscode-icons:file-type-shell~]
node --version
pnpm --version
pnpm install
pnpm build
```

:::

## 常用检查

::: code-group

```bash [质量检查 ~vscode-icons:file-type-shell~]
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:postgres
pnpm prompt:test
pnpm build
git diff --check
```

```bash [信息 DAG 架构边界 ~vscode-icons:file-type-shell~]
pnpm exec tsx scripts/information-architecture.test.ts
```

```bash [聚焦测试 ~vscode-icons:file-type-shell~]
pnpm exec vitest run packages/runtime/src
pnpm exec vitest run packages/engine/src
pnpm exec vitest run apps/server/src
```

:::

`typecheck` 使用 TypeScript build mode，可能更新 `dist/` 和增量构建信息；它不是 no-emit 检查。Promptfoo 使用固定数据和本地 source bridge，不创建真实模型，也不读取 API Key。

## 测试边界

**模型** — 使用 `ai/test` 的确定性模型，禁止访问真实 Provider。

**数据库** — 普通测试使用 PGlite，不读取个人环境中的数据库或配置目录。`pnpm test:postgres` 使用测试专用的 `KAGUYA_TEST_DATABASE_URL`，在 CI 提供的真实 PostgreSQL 服务上运行与 PGlite 共用的账本契约、索引和重连检查；它不是 Server 的生产配置。

**信息 DAG** — 测试提交优先于广播、多个消费者的并发与隔离、派生原子的 `core:caused-by`/`core:context`，以及 `consumer.failed`、LLM 失败和投递失败的持久化事实。

**配置** — 只使用 `test-only-placeholder` 一类无效凭据，并验证错误和日志不会泄漏明文。模型解析只使用启动时的全局 `selectedProfileId`，测试不得向模块或消息注入 `profileId`。

**时间与 ID** — 使用可注入时钟和 information ID 生成器，不通过真实等待制造测试条件。

**网络** — 普通测试和 Promptfoo 回归都不得访问外网。

## 包依赖规则

**Schema** — 只定义跨包数据契约，不依赖其他 Kaguya 包。

**SDK** — 可以依赖 Schema，公开 Information Kind 与模块定义 API。

**Engine** — 可以依赖 SDK 与 Schema，提供 `InformationCore`、Kind Registry、广播与 ModuleHost，不导入应用或具体数据库/LLM 实现。

**Runtime 与模块** — Runtime 组合 PostgreSQL ledger、Core、LLM 与 transport；模块只订阅 Kind 并通过 `context.register()` 派生原子。

**基础设施包** — Scheduler、Prompt、LLM、Database 和 Config 通过 Schema 共享契约，彼此不形成循环依赖。

**应用** — `apps/*` 是 composition root，可以注入所有基础包；基础包不得反向导入应用。

新增 workspace 包时，同时更新包的 `package.json` 依赖、TypeScript references 和根 `tsconfig.json`。仅增加 TypeScript reference 会导致编译与包管理器解析不一致。

## PostgreSQL 账本迁移

数据库模式由 `packages/database/src/migrations.ts` 管理，并由 `KaguyaDatabase.migrate()` 在事务中创建或更新。payload 使用 `JSONB`；原子与显式引用由外键保护，原子、引用和日志投影 outbox 在同一事务写入。信息原子与引用只允许追加；状态变化必须注册新原子，而不能更新或删除旧记录。

不要为 SQLite 保留兼容写入路径，也不要实现旧 SQLite 文件的自动导入或转换。迁移或连接失败必须显式报告，且日志不得包含完整数据库 URL、凭据、消息正文、Prompt 或模型输出。

## 文档同步要求

环境、命令或开发规范变化时更新根 README 与本站；公共信息 Kind、模块接口或依赖方向变化时更新架构和参考页；规划中的能力必须明确标为规划。

提交前确认没有密钥、数据库 URL、个人配置、日志或 `.data/` 产物进入 diff，并确保分支只包含本任务相关改动。
