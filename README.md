# Kaguya

Kaguya 是一个以持久化信息原子（Information Atom）组织消息处理的 TypeScript AI Bot Runtime。`apps/server` 是唯一长期运行入口：它在同一进程和端口提供 Web UI、HTTP API 与可选的 NapCat 连接，并把正规化后的平台内容提交给唯一的 `@kaguya/runtime` ingress。

每一项 Core 运行事实只有一个身份：`informationId`。入站文本、过滤结果、LLM 生命周期、assistant 文本、投递请求与投递结果都是不可变原子；原子之间用显式引用构成 DAG，而不是依赖隐式的执行身份。

## 快速开始

需要 Node.js 24.18.0、pnpm 11.9.0，以及已启动的 Docker Desktop、OrbStack 或其他兼容 Docker CLI 的引擎。开发命令会准备固定的 PostgreSQL 17 容器；不使用 Compose、PGlite 或 SQLite 代替本地验收。

```bash
corepack enable
pnpm install
# macOS 使用 Docker Desktop 时，先启动并等待引擎就绪
open -a Docker
docker info
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm dev
```

Server 每次启动都会生成新的 Gateway Token，并在成功监听后打印完整的 `Kaguya access URL`。必须通过该链接进入 Web UI；刷新会保留 URL fragment 中的 token，Server 重启后需要使用终端打印的新链接。Server 只允许监听 `127.0.0.1`、`localhost` 或 `::1`。

`KAGUYA_CONFIG_ROOT` 指向权限受保护的 Profile Registry。Registry 有且只有一个显式的 `selectedProfileId`；Server 的 host、port、database、Web 路径、CORS、代理、限流、日志、allowlist、AI、Memory 与平台都来自这个 Profile。首次 `pnpm dev` 会在缺少整个 `runtime` 时保留其他 Profile 内容并补入安全的本地 runtime；部分损坏的 runtime 会被拒绝而不会覆盖。

数据库连接、PostgreSQL 17、严格 schema v1 和 Runtime Kind 必须在任何监听启动前通过。数据库 schema 不兼容会直接终止 Server；AI 配置尚未完成时仍会开放 Web 配置界面，Runtime 与 NapCat 保持停止。Web UI 保存或切换 selected Profile 只写入配置；进入“配置生效管理”点击“应用当前配置”，才会热重载模型、人设、Memory、NapCat 和白名单，无需重新打开访问链接。端口、数据库地址等进程级字段变更仍需在原终端按 `Ctrl+C`，重新执行 `pnpm dev`（生产模式使用 `pnpm start`），然后打开新打印的完整访问链接。初始化格式与密钥边界见 [`@kaguya/config`](packages/config/README.md)。

Web UI 的 NapCat 页面只读写 selected Profile 的 `platforms` 条目。

生产运行：

```bash
pnpm build
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm start
```

## 升级后的配置迁移与消息排查

启动不会自动迁移旧 Registry。升级后遇到 `CONFIG_CORRUPT_STORE` 时，先停止服务并手动备份整个 `KAGUYA_CONFIG_ROOT` 目录（包含 `index.json`、`profiles/` 和 `modules/`）；备份含凭据，请限制访问权限。

对已知 v3 Registry，按新版格式手动更新所有被索引引用的 Profile：保留 ID、名称、模型及平台凭据，移除已退役的 `plugins` 和 `runtime.gatewayToken`，补齐缺失的 `identity`（name、至少一个不同于 name 的 aliases、非空 persona）与 `memory: { "enabled": false }`。runtime 需包含 `databaseMode`（按实际数据库选 managed 或 external）及 `gatewayAllowlist`（空数组拒绝平台消息）。完整字段定义见 [`@kaguya/config`](packages/config/README.md)。旧插件配置只保留在备份中，不自动启用为新版模块。

全部 Profile 符合 v1 后，再手动将索引版本改为 `1`，保留原来的 Profile 元数据和 `selectedProfileId`；不要只修改索引版本而跳过 Profile 更新。随后运行 `pnpm dev` 或 `pnpm start` 校验。若仍报错，按校验结果检查文件或停止服务后恢复整份备份。此过程不迁移数据库，也不修改独立模块配置；未知格式不应套用 v3 步骤。

Web 配置页可分别设置轻量、重量模型的**模型调用超时**（0.001–300 秒，默认 300 秒）；该值覆盖模型请求及响应读取。推荐响应时间仍只是软预算。默认 durable lease 为 330 秒，为最长模型调用预留 30 秒提交余量；进程崩溃后的无主任务也可能要等租约到期才能恢复。

使用 QQ 前必须配置 **Gateway Allowlist**：`qq:group:778899` 允许指定群，`qq:private:112233` 允许指定用户；`qq:group:*` 和 `qq:private:*` 分别允许所有群和私聊。空列表会拒绝所有非 Web 入站消息，因此 NapCat 显示已连接仍可能没有回复。保存并应用后，从实际 QQ 群或私聊发送消息，检查入站平台与最终 `core.delivery.delivered` 事实。

热应用期间消息入口会短暂暂停，当前任务有界收尾；新配置启动失败时尝试恢复旧配置。文件手工修改不会自动触发应用，需在设置菜单中显式应用；不支持模块代码热更新。接口、失败恢复及仍需重启的字段见 [配置生效说明](packages/config/configuration-apply-design.md)。

## 信息 DAG

Runtime 为入站内容创建 context 根原子，再注册 `core.message.inbound.text`。`InformationCore.register()` 会生成信息原子、完成校验并提交 PostgreSQL 账本；只有提交成功后，才向该 Kind 的当前消费者并发广播。没有消费者的原子同样会保留。

默认链路是：

```text
core.runtime.context
  -> core.message.inbound.text
  -> agent.heartbeat.scheduled -> agent.turn.candidate
  -> agent.turn.claimed -> agent.turn.context.completed
  -> agent.attention.arousal.completed (attend)
  -> agent.message.intent.requested
  -> core.model.task.requested
  -> core.model.task.completed
  -> core.message.assistant.text
  -> core.delivery.requested
  -> core.delivery.delivered | core.delivery.failed

core.model.task.requested
  -> core.model.task.failed（终止该分支）
```

Heartflow 将 eligible turn 确定性分派为当前会话 Message Intent；Composer 使用完整冻结 turn 生成普通 text。入站引用仅用于理解上下文，不会成为默认出站 reply。消费者抛出或 reject 时，输入原子不会回滚，其他消费者仍会独立完成，Core 会追加 `consumer.failed` 作为失败事实。消费者不会因此自动重试。

账本把 payload 保存为 PostgreSQL `JSONB`，并用外键保护原子与引用关系。原子、引用及其日志投影 outbox 会在同一事务中写入；outbox 在提交后再交给日志 sink 投影，因此日志失败不会改变已经提交的运行事实。

## 常用命令

- `pnpm dev`：先完整执行托管 PostgreSQL 17 的 start/check，再启动唯一 Server 与内嵌 Vite。
- `pnpm postgres:start`：创建或恢复托管容器，等待健康，初始化空 schema 或验证当前 v1，并同步 Kind。
- `pnpm postgres:status`：只报告 Profile 模式、容器状态、健康、PostgreSQL 大版本和端口。
- `pnpm postgres:check`：不改变容器生命周期，验证 PostgreSQL 17、当前 schema v1 与 Kind。
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

**selected Profile `runtime`** — 保存必填的 `databaseMode`、`databaseUrl` 以及 Server 的 host、port、Web、CORS、代理、限流、日志和 allowlist。外部数据库只通过 Profile JSON 配置。

**Gateway Token** — 每次启动安全随机生成，只存在于进程和访问链接中；旧 Profile 中的持久化 token 会被忽略，并在下一次 Profile 写入时清理。

托管实例固定使用 `postgres:17-alpine`、容器 `kaguya-postgres-17` 和卷 `kaguya-postgres-17-data`，默认只绑定 `127.0.0.1:5432`。首次创建可用 `pnpm postgres:start -- --port 55432` 覆盖；已有实例端口不匹配时会安全失败，不会自动重建。普通停止、Server 退出和测试结束都保留容器、卷及数据。完整列表见[环境变量参考](docs/reference/environment-variables.md)。

## 仓库结构

```text
apps/server/        Server 宿主：HTTP、Web、NapCat、Runtime 与关闭流程
apps/web/           React/Vite 同源浏览器客户端
apps/demo/          PostgreSQL 信息 DAG 的确定性演示 runner
packages/composition/ Server 与 Demo 共用的 Runtime 业务装配
packages/runtime/   信息 ingress、DAG 组合、LLM 生命周期与投递结果
packages/engine/    InformationCore、Kind Registry、并发广播与 ModuleHost
packages/modules/   消息 Kind、Heartflow 与 Message Composer 模块
packages/database/  PostgreSQL 信息账本、迁移与日志投影 outbox
packages/llm/       LLM 调用、输出校验与错误归一化
packages/modules/templates/  一方 Prompt 文本模板
packages/logger/    结构化日志、上下文与脱敏
packages/schema/    跨包数据契约
packages/sdk/       Information Kind 与模块定义 API
packages/platform-adapters/ OneBot/NapCat/Web 正规化与 transport 契约
```

## 文档

当前文档只维护 `docs/guide/`、`docs/design/`、`docs/developers/`、`docs/reference/` 和 `docs/project/`，并与本分支代码、测试及各 package README 核对事实。历史材料仅供审计，已移至[冻结归档](https://github.com/posanbu/Kaguya/tree/3622c77bc3d3b9a947bb76082164095284cf6edb)；归档不描述当前行为，不再更新或参与站点发布。

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

模块是受信任的同进程代码。Core 按当前订阅者快照实时广播：没有持久订阅、离线补投、工作队列、消费者优先级或自动重试。系统同样没有去重、模块代码热更新、模块沙箱、隐式会话分组或 Web 回复读取/SSE 通道。旧 SQLite 数据不会自动导入、转换或删除。旧配置由用户手动备份并更新，启动只接受 v1，详见上方更新说明。
