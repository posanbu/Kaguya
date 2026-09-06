---
title: 参与贡献
description: Kaguya 开发环境、测试、包依赖和提交检查。
---

# 参与贡献

代码和文档应在同一变更中保持一致。功能与修复采用小步 RED、GREEN、REFACTOR，并优先断言公开结果、持久化记录或 trace。

## 固定开发环境

仓库要求 Node.js 24.18.0、pnpm 11.9.0 和根 `pnpm-lock.yaml`。首次安装或切换到包含包导出变化的分支后，先执行完整构建。

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
pnpm test
pnpm prompt:test
pnpm build
pnpm typecheck
git diff --check
```

```bash [聚焦测试 ~vscode-icons:file-type-shell~]
pnpm exec vitest run packages/runtime/src
pnpm exec vitest run packages/config/src
pnpm exec vitest run apps/server/src
```

:::

`typecheck` 使用 TypeScript build mode，可能更新 `dist/` 和增量构建信息；它不是 no-emit 检查。Promptfoo 使用固定数据和本地 source bridge，不创建真实模型，也不读取 API Key。

## 测试边界

**模型** — 使用 `ai/test` 的确定性模型，禁止访问真实 Provider。

**数据库** — 使用临时 SQLite，不读取个人 `.data/`。

**配置** — 只使用 `test-only-placeholder` 一类无效凭据，并验证错误和日志不会泄漏明文。

**时间与 ID** — 使用可注入时钟和 ID 生成器，不通过真实等待制造测试条件。

**网络** — 普通测试和 Promptfoo 回归都不得访问外网。

## 包依赖规则

**Schema** — 只定义跨包契约，不依赖其他 Kaguya 包。

**SDK** — 可以依赖 Schema，公开声明式事件、模块和工作流定义。

**Engine** — 可以依赖 SDK 与 Schema，不导入应用或具体数据库/LLM 实现。

**基础设施包** — Scheduler、Prompt、LLM、Database 和 Config 通过 Schema 共享契约，彼此不形成循环依赖。

**应用** — `apps/*` 是 composition root，可以注入所有基础包；基础包不得反向导入应用。

新增 workspace 包时，同时更新包的 `package.json` 依赖、TypeScript references 和根 `tsconfig.json`。仅增加 TypeScript reference 会导致编译与包管理器解析不一致。

## SQLite 迁移

迁移位于 `packages/database/src/migrations.ts`。已发布 migration 不得重写；每次新增更高且唯一的整数版本，并在一个 `BEGIN IMMEDIATE` 事务中执行 DDL 与版本记录。

迁移不得静默删除用户数据。新字段需要同步更新 schema、repository 写入、行重建、错误校验和往返测试。

## 日志与敏感数据

运行时代码使用 `@kaguya/logger`，不要新增另一套 JSON logger。普通日志禁止包含消息正文、Prompt、模型回答、HTTP body/headers、完整 Provider URL 或凭据。

默认 redaction 只是误用兜底，不是记录敏感数据的授权。需要审计 Prompt 与模型输出时，只使用受控 SQLite trace repository。

## 文档同步要求

环境、命令或开发规范变化时更新根 README 与本网站；公开 API、事件或依赖方向变化时更新架构和参考页；规划中的能力必须明确标注为规划。

提交前确认没有密钥、个人数据库、日志或 `.data/` 产物进入 diff，并确保分支只包含本任务相关改动。

