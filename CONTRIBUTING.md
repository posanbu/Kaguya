# 贡献指南

Kaguya 的运行期事实以持久化信息原子组成 DAG。修改代码时，优先从一个可观察行为开始：原子是否按预期提交、引用是否正确、消费者失败是否留下事实，以及公共 HTTP/配置边界是否保持一致。代码、测试和公开文档应在同一变更中更新。

## 环境准备

仓库锁定 Node.js 24.18.0 和 pnpm 11.9.0。Node 版本是本地与 CI 的共同基线；开发、测试和服务运行围绕 PostgreSQL information ledger 展开。

使用 nvm：

```bash
nvm install
nvm use
node --version
```

使用 fnm：

```bash
fnm install
fnm use
node --version
```

nvm 读取 `.nvmrc`，fnm 读取 `.node-version`；两者都应显示 `v24.18.0`。然后通过 Corepack 启用仓库声明的 pnpm：

```bash
corepack enable
corepack install --global pnpm@11.9.0
pnpm --version
pnpm install
```

`pnpm --version` 应为 `11.9.0`。依赖版本由根 `pnpm-lock.yaml` 管理，不要改用 npm 或 yarn 安装。

服务与 demo 都要求非空的 `KAGUYA_DATABASE_URL`。它是 PostgreSQL 连接 URL，不应放入版本控制、测试夹具或普通日志：

```bash
export KAGUYA_DATABASE_URL="postgresql://kaguya:password@127.0.0.1:5432/kaguya"
```

`KAGUYA_DATABASE_PATH` 和其他旧 SQLite 环境变量会被 Server 拒绝。旧 SQLite 文件没有自动导入、转换、合并或删除路径。

## 配置与敏感数据

本地示例使用 `.data/kaguya-config`；生产环境应使用仓库外、仅运行账号可访问的绝对路径。配置根、Registry 索引和全部 Profile JSON 都是敏感文件，因为其中可能含有 API key、平台凭据和插件密钥。

Profile Registry 只有一个显式的 `selectedProfileId`。Server 在启动时读取该 Profile 一次，再为 Runtime 构造共享模型解析器。模块 settings、平台消息和信息原子都不能指定或覆盖 Profile；选中的 Profile 不可用时也不会回退到别的 Profile、Provider 或模型。

在 POSIX 系统中，目录应为 `0700`、文件应为 `0600`。Windows 部署必须由管理员设置只允许运行身份访问的 NTFS ACL。每个配置根目录任意时刻只能有一个活动 `FileUserConfigManager` 或写入进程；当前实现不协调多个 manager 实例或跨进程写入。

禁止把真实配置复制进测试、日志、Issue、PR 或聊天记录。测试只使用 `test-only-placeholder` 一类无效值。如果密钥进入 Git，应先撤销或轮换密钥，再评估访问记录并按需清理仓库历史；仅添加 `.gitignore` 或删除最新版本不能使已泄漏密钥恢复安全。

## 信息 DAG 与模块边界

`InformationCore.register()` 是唯一的原子写入入口。它生成并校验原子、提交 PostgreSQL 账本，然后才向当前消费者快照并发广播。提交失败时不会广播；没有消费者时原子仍会保留。运行期事实只以 `informationId` 标识，关系由显式引用表达。

模块用 `onInformation` 订阅某个 Information Kind，并通过 handler 的 `context.register()` 注册下一原子。ModuleHost 会补齐模块 source、直接 `core:caused-by` 与继承的 `core:context`。模块 manifest 必须列出订阅和输出的 Kind；额外 relation 必须为非保留 relation，且在目标 Kind definition 的 `references` 中预先声明。

过滤通过时显式注册下一个 Kind，拒绝时只注册 `filter.decision`。消费者抛出或 reject 时，Core 记录 `consumer.failed`；输入不会回滚，其他消费者继续独立执行。LLM 与投递也分别记录完成或失败的原子。当前没有持久订阅、离线补投、工作队列、优先级、定向派发或自动重试。

## 日志与 API 边界

运行时代码使用 `@kaguya/logger`，不要新增 `console.log/error` 或另一套 JSON logger。应用入口创建根 Logger，模块通过 `createModuleLogger()` 创建 child Logger；需要关联运行事实时使用仓库支持的安全上下文，并保留 `informationId`、Kind 与 source 等非敏感字段。

日志对象必须提供稳定 `event` 字段，不把用户消息、Prompt、模型回答、HTTP body/headers、完整 provider URL、数据库 URL、凭据或原始 provider Error 写入普通日志。默认 redaction 和安全 serializer 只是兜底；新增字段时仍须检查敏感性并补充不会泄漏的测试。

`apps/server` 是 HTTP composition root。Web 与 NapCat 只持有窄 `InformationIngress.submit()`，不能直接访问数据库、Core 或模块。`POST /api/v1/messages` 的 `202 accepted` 仅表示 HTTP Server 已开始异步提交，不表示模型或投递完成；当前没有回复查询或 SSE。Profile 管理路由与错误码的精确定义见 `docs/reference/http-api.md`。

## 开发命令

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm prompt:test
pnpm demo
```

- `build` 构建 TypeScript project references 和 Web 产物。
- `typecheck` 检查 TypeScript project references 与 Web；它使用 build mode，可能更新 `dist/` 和增量构建信息。
- `lint` 检查 TypeScript、JavaScript 和 CommonJS 辅助脚本。
- `test` 运行 Vitest 单元与集成测试。
- `prompt:test` 在阻断外部出口的前提下验证 Prompt 结构，不读取 API key。
- `demo` 使用 `KAGUYA_DATABASE_URL` 运行确定性信息 DAG，并输出根 `informationId` 与 Kind 计数。

格式与文档检查：

```bash
pnpm format
pnpm format:check
pnpm --dir docs --ignore-workspace docs:check
```

`docs/` 是独立 pnpm workspace，不属于根 `pnpm-workspace.yaml` 的 `apps/*`/`packages/*` 范围。

## 测试边界

测试以外部行为与持久化事实为边界，而不是已删除的事件、工作流或执行关联字段。

- **Schema 与 SDK**：校验 Information Atom、Kind definition、payload、引用规则与模块 API。
- **Engine**：验证 Kind Registry、提交先于广播、同 Kind 消费者并发、因果引用，以及 `consumer.failed` 的隔离和递归保护。
- **Modules 与 Runtime**：验证过滤 DAG、LLM requested/completed/failed、assistant、delivery requested/delivered/failed、关闭 drain 与 ingress 生命周期。
- **Database**：使用 PGlite 或测试注入的 PostgreSQL 兼容数据库，验证 append-only 原子、引用和日志投影 outbox；不读取个人数据库。
- **Config、Server 与 Web**：验证全局 `selectedProfileId`、Profile management、认证、HTTP 响应、窄 ingress 和 setup mode。
- **平台适配器与 demo**：验证平台内容正规化、transport receipt 与 PostgreSQL demo。

测试不得访问真实 Provider、网络或 API key。LLM 使用 `ai/test` 确定性模型；配置使用无效占位凭据，并验证错误、日志和返回值不泄漏明文。时间与 information ID 使用可注入时钟和生成器，不通过真实等待制造测试条件。

完成必要构建后，可按目录运行聚焦测试：

```bash
pnpm exec vitest run packages/engine/src
pnpm exec vitest run packages/runtime/src
pnpm exec vitest run packages/database/src
pnpm exec vitest run packages/platform-adapters/src
pnpm exec vitest run apps/server/src
pnpm exec vitest run apps/web/src
```

`prompt:test` 不是普通 Vitest 用例；修改 Prompt 编译器或断言时，应同时运行相应 Vitest 与 `pnpm prompt:test`。

## TDD、数据库与包依赖

功能和修复遵循小步 RED、GREEN、REFACTOR：先写并运行能表达行为的失败测试，再实现最小改动，最后整理命名与重复。修复 bug 时必须先加入回归测试。涉及信息图的测试应断言已提交原子、Kind 和直接引用，而不是只断言内部调用次数。

PostgreSQL 模式迁移位于 `packages/database/src/migrations.ts`，由 `KaguyaDatabase.migrate()` 在数据库事务中执行。迁移必须保持可重复执行，SQL 值使用参数化查询，信息原子与引用只能追加；状态变化应注册新原子，不能更新或删除旧记录。不要在应用或其他包中执行临时 DDL，也不要保留 SQLite 兼容写入路径。

包依赖必须保持单向：`schema` 不依赖其他 Kaguya 包；`sdk` 可依赖 `schema`；`engine` 可依赖 `sdk` 和 `schema`；Runtime 负责组合 Engine、Database、LLM、Modules 与 transport；`apps/*` 是 composition root，基础包不得反向导入应用。新增 workspace 包时，同步更新 `package.json`、TypeScript references、根 `tsconfig.json` 和 lockfile。

## 文档与提交前检查

公开 API、Information Kind、模块边界、环境变量、数据库或依赖方向变化时，同一提交更新 README 和相关文档。架构变更更新 `docs/developers/architecture.md`，模块 SDK 变更更新 `docs/developers/information-modules.md`，HTTP/Profile 变更更新 `docs/reference/http-api.md`。文档只陈述当前代码已实现的能力，不把内部设计稿或计划加入公开导航。

提交前从仓库根目录运行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm prompt:test
pnpm build
pnpm exec tsx scripts/information-architecture.test.ts
pnpm --dir docs --ignore-workspace docs:check
git status --short
git diff --check
```

最后确认没有密钥、数据库 URL、个人配置、日志或 `.data/` 产物进入 diff；没有暂存无关文件；新的公共行为同时有测试和文档；提交信息描述用户或开发者可观察到的结果。
