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

数据库连接、PostgreSQL 17、严格 schema v1 和 Runtime Kind 必须在任何监听启动前通过。数据库 schema 不兼容会直接终止 Server；AI 配置尚未完成时仍会开放 Web 配置界面，Runtime 与 NapCat 保持停止。Web UI 保存或切换 selected Profile 后会自动应用模型、人设、Memory、NapCat 和白名单配置，无需重新打开访问链接；设置菜单的“配置生效管理”也可手动应用或重试。端口、数据库地址等进程级字段变更仍需在原终端按 `Ctrl+C`，重新执行 `pnpm dev`（生产模式使用 `pnpm start`），然后打开新打印的完整访问链接。初始化格式与密钥边界见 [`@kaguya/config`](packages/config/README.md)。

Web UI 的 NapCat 页面只读写 selected Profile 的 `platforms` 条目。

生产运行：

```bash
pnpm build
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm start
```

## 升级后的配置迁移与消息排查

`pnpm dev`、`pnpm postgres:start` 和 `pnpm start` 会在读取配置前自动迁移已知的 v3 Registry。迁移先校验所有 Profile，再在配置根目录创建 `migration-backup-v3-<UUID>/`，保存原索引和全部被索引引用的 Profile；备份含凭据，目录权限为 0700、文件权限为 0600。迁移保留 Profile 名称、选中项、模型及平台凭据，补入缺失的默认 identity、关闭状态的 memory，并移除已退役的 `plugins` 和旧 `runtime.gatewayToken`。旧插件设置仅保留在备份中，不会自动启用为新版模块；请检查默认人设、Memory 与平台规则后使用。

已有的数据库模式和 Gateway Allowlist 会保留。旧配置缺少 `databaseMode` 时按旧版语义设为 `external`，缺少白名单时设为空列表；不会猜测数据库属于托管容器，也不会自动开放 QQ 消息。迁移不处理数据库 schema，不修改独立模块配置。未知版本、未知字段及损坏配置继续报错；不要手工把 `version: 3` 改为 `1`，否则无法识别完整的旧格式。

正式配置写入中断时，旧 v3 索引与完整备份仍保留，重新启动会继续转换。若进程崩溃留下 `.migration-lock`，先确认所有 Kaguya 进程均已停止，再删除配置根目录内这个空锁目录并重试。需要回退时，停止服务，将备份中的 `index.json` 和 `profiles/` 一起恢复，并使用相应旧版程序。完整备份最后才生成自身的 `index.json`；没有该文件的目录属于未完成备份，不能用于恢复。备份中的 JSON 字段和值保持原样，排版可能变化。

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
apps/server/        唯一 composition root：HTTP、Web、NapCat、Runtime 与关闭流程
apps/web/           React/Vite 同源浏览器客户端
apps/demo/          PostgreSQL 信息 DAG 的确定性演示 runner
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

模块是受信任的同进程代码。Core 按当前订阅者快照实时广播：没有持久订阅、离线补投、工作队列、消费者优先级或自动重试。系统同样没有去重、模块代码热更新、模块沙箱、隐式会话分组或 Web 回复读取/SSE 通道。旧 SQLite 数据不会自动导入、转换或删除。已知 v3 配置索引会在启动前备份并迁移到 v1；其他旧格式继续拒绝，详见上方迁移说明。
