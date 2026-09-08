# Kaguya

Kaguya 是一个以持久化信息原子（Information Atom）组织消息处理的 TypeScript AI Bot Runtime。`apps/server` 是唯一长期运行入口：它在同一进程和端口提供 Web UI、HTTP API 与可选的 NapCat 连接，并把正规化后的平台内容提交给唯一的 `@kaguya/runtime` ingress。

每一项 Core 运行事实只有一个身份：`informationId`。入站文本、过滤结果、LLM 生命周期、assistant 文本、投递请求与投递结果都是不可变原子；原子之间用显式引用构成 DAG，而不是依赖隐式的执行身份。

## 快速开始

需要 Node.js 24.18.0、pnpm 11.9.0，以及已启动的 Docker Desktop、OrbStack 或其他兼容 Docker CLI 的引擎。开发命令会准备固定的 PostgreSQL 17 容器；不使用 Compose、PGlite 或 SQLite 代替本地验收。

```bash
corepack enable
pnpm install
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm dev
```

Server 每次启动都会生成新的 Gateway Token，并在成功监听后打印完整的 `Kaguya access URL`。必须通过该链接进入 Web UI；刷新会保留 URL fragment 中的 token，Server 重启后需要使用终端打印的新链接。Server 只允许监听 `127.0.0.1`、`localhost` 或 `::1`。

`KAGUYA_CONFIG_ROOT` 指向权限受保护的 Profile Registry。Registry 有且只有一个显式的 `selectedProfileId`；Server 的 host、port、database、Web 路径、CORS、代理、限流、日志、allowlist、AI、Memory、平台与插件都来自这个 Profile。首次 `pnpm dev` 会在缺少整个 `runtime` 时保留其他 Profile 内容并补入安全的本地 runtime；部分损坏的 runtime 会被拒绝而不会覆盖。

数据库连接、PostgreSQL 17、migration 和 Runtime Kind 必须在任何 HTTP、Runtime 或平台 ingress 监听前通过。AI 配置尚未完成时，检查通过后仍会开放 Web setup；Runtime 与 NapCat 保持停止。修改或切换 selected Profile 后需要重启。初始化格式与密钥边界见 [`@kaguya/config`](packages/config/README.md)。

Web UI 的 NapCat 页面读写 selected Profile 的 `platforms` 条目。旧 `napcat.json` 和 `KAGUYA_NAPCAT_*` 环境变量会触发不含凭据的迁移错误，不再作为配置来源。

生产运行：

```bash
pnpm build
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm start
```

## 信息 DAG

Runtime 为入站内容创建 context 根原子，再注册 `core.message.inbound.text`。`InformationCore.register()` 会生成信息原子、完成校验并提交 PostgreSQL 账本；只有提交成功后，才向该 Kind 的当前消费者并发广播。没有消费者的原子同样会保留。

默认链路是：

```text
core.runtime.context
  -> core.message.inbound.text
  -> core.reply.requested
  -> core.llm.requested
  -> core.llm.completed
  -> core.message.assistant.text
  -> core.delivery.requested
  -> core.delivery.delivered | core.delivery.failed

core.llm.requested
  -> core.llm.failed（终止该分支）
```

过滤器通过注册下一个 Kind 来推进链路；拒绝时只注册 `filter.decision`。消费者抛出或 reject 时，输入原子不会回滚，其他消费者仍会独立完成，Core 会追加 `consumer.failed` 作为失败事实。消费者不会因此自动重试。

账本把 payload 保存为 PostgreSQL `JSONB`，并用外键保护原子与引用关系。原子、引用及其日志投影 outbox 会在同一事务中写入；outbox 在提交后再交给日志 sink 投影，因此日志失败不会改变已经提交的运行事实。

## 常用命令

- `pnpm dev`：先完整执行托管 PostgreSQL 17 的 start/check，再启动唯一 Server 与内嵌 Vite。
- `pnpm postgres:start`：创建或恢复托管容器，等待健康并执行 migration/Kind 同步。
- `pnpm postgres:status`：只报告 Profile 模式、容器状态、健康、PostgreSQL 大版本和端口。
- `pnpm postgres:check`：不改变容器生命周期，验证 PostgreSQL 17 并幂等执行 migration/Kind 同步。
- `pnpm build`：构建 packages、Server 与 Web 产物。
- `pnpm start`：以生产模式启动构建后的 Server；只使用 selected Profile 数据库，绝不管理 Docker。
- `pnpm demo`：使用 selected Profile 数据库运行确定性信息 DAG，并输出根 `informationId` 与 Kind 计数。
- `pnpm test`：运行单元和集成测试。
- `pnpm test:postgres`：本地自动复用同一托管实例；CI 提供 `KAGUYA_TEST_DATABASE_URL` 时绕过 Docker 和 Profile。
- `pnpm typecheck`：检查 TypeScript project references 和 Web。
- `pnpm lint`：运行 ESLint。
- `pnpm prompt:test`：在阻断外部出口后验证 Prompt 结构。

## 统一配置

**`KAGUYA_CONFIG_ROOT`** — 默认 `.data/kaguya-config`。保存 Profile Registry、Provider 和模型配置，必须按敏感数据保护。

**selected Profile `runtime`** — 保存 `databaseMode`、`databaseUrl` 以及 Server 的 host、port、Web、CORS、代理、限流、日志和 allowlist。外部数据库只通过 Profile JSON 配置；旧 Profile 未声明 `databaseMode` 时按 `external` 处理。

**Gateway Token** — 每次启动安全随机生成，只存在于进程和访问链接中；旧 Profile 中的持久化 token 会被忽略，并在下一次 Profile 写入时清理。

托管实例固定使用 `postgres:17-alpine`、容器 `kaguya-postgres-17` 和卷 `kaguya-postgres-17-data`，默认只绑定 `127.0.0.1:5432`。首次创建可用 `pnpm postgres:start -- --port 55432` 覆盖；已有实例端口不匹配时会安全失败，不会自动重建。普通停止、Server 退出和测试结束都保留容器、卷及数据。完整列表见[环境变量参考](docs/reference/environment-variables.md)。

## 仓库结构

```text
apps/server/        唯一 composition root：HTTP、Web、NapCat、Runtime 与关闭流程
apps/web/           React/Vite 同源浏览器客户端
apps/demo/          PostgreSQL 信息 DAG 的确定性演示 runner
packages/runtime/   信息 ingress、DAG 组合、LLM 生命周期与投递结果
packages/engine/    InformationCore、Kind Registry、并发广播与 ModuleHost
packages/modules/   消息 Kind 与 filter/LLM 回复模块
packages/database/  PostgreSQL 信息账本、迁移与日志投影 outbox
packages/llm/       LLM 调用、输出校验与错误归一化
packages/prompt/    Prompt 编译与 provenance
packages/logger/    结构化日志、上下文与脱敏
packages/schema/    跨包数据契约
packages/sdk/       Information Kind 与模块定义 API
packages/platform-adapters/ OneBot/NapCat/Web 正规化与 transport 契约
```

## 文档

- [文档站首页](docs/index.md)
- [安装与启动](docs/guide/installation.md)
- [配置 Kaguya](docs/guide/configuration.md)
- [Web UI](docs/guide/webui.md)
- [运行时架构](docs/developers/architecture.md)
- [信息模块 SDK](docs/developers/information-modules.md)
- [HTTP API](docs/reference/http-api.md)
- [环境变量](docs/reference/environment-variables.md)
- [配置包说明](packages/config/README.md)
- [贡献指南](CONTRIBUTING.md)

## 当前边界

模块是受信任的同进程代码。Core 按当前订阅者快照实时广播：没有持久订阅、离线补投、工作队列、消费者优先级或自动重试。系统同样没有去重、热更新、模块沙箱、隐式会话分组或 Web 回复读取/SSE 通道。旧 SQLite 数据与旧配置索引不会自动导入、转换或删除。
