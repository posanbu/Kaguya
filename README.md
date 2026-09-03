# Kaguya

Kaguya 是一个事件驱动、模块可插拔的 TypeScript AI Bot Runtime。仓库只有一个长期运行的应用入口：`apps/server` 在同一进程、同一端口上提供 Web UI、HTTP API 和可选 NapCat 连接，并通过唯一的 `@kaguya/runtime` 处理消息。

核心能力包括：

- `KaguyaRuntime` 统一持有 SQLite、EventBus、ModuleHost、LLM execution port 和 outbound transport registry；
- 入站消息先落库并广播 `message.ingested`；模块自行过滤、组织上下文、请求 LLM 和选择出站目标；
- 入站消息不包含分组标识，Core 不根据私聊、群聊、用户或 HTTP 字段建立或隔离历史；
- Fastify 同端口提供 UI、`/healthz`、OpenAPI 和受 Bearer Token 保护的消息 API；
- 开发环境由 Fastify 内挂 Vite middleware，HMR 不需要第二个 Web 服务；
- NapCat 可选且独立重连，断线不会影响 HTTP 和 Web UI；
- 开发默认 pretty 日志、生产默认 JSON，并统一关联 request、trace、event 和 workflow node；
- 默认 demo 模块链为 `always filter → LLM reply → outbound request`。

## 快速开始

需要 Node.js 24.18.0 和 pnpm 11.9.0。

```bash
corepack enable
pnpm install
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm dev
```

`KAGUYA_GATEWAY_TOKEN` 可选：显式设置（至少 16 字符）时作为最高优先级 Gateway Token。全新本地配置且仅监听 loopback 时，Server 会在终端展示一次性引导 Token；首次配置成功后生成并持久化正式凭据。

`KAGUYA_CONFIG_ROOT` 指向权限受保护的 profile store。目录尚未初始化或当前全局选中的 profile 不完整时，Server 会进入统一配置模式并显示引导页；如果当前 selected Profile 仍然 `invalid` 或存在未解决的 Provider 配置问题，页面会继续展示 readiness 问题。只有当用户选择了某个 Profile，或完整替换了当前 selected Profile，且该 selected Profile 已 ready 时，页面才会进入 `restart_required` 并要求重启服务。配置文件损坏或权限异常仍会拒绝启动，不会自动覆盖。初始化格式与密钥边界见 [`@kaguya/config`](packages/config/README.md)。打开 `http://127.0.0.1:3000` 后，页面和 API 使用同源路径。

WebUI 的 Profile 页面旁提供独立的 NapCat 配置页。NapCat 配置实际保存到 `KAGUYA_CONFIG_ROOT/napcat.json`，保存后重启服务即可生效；若未保存过该文件，仍可使用 `KAGUYA_NAPCAT_*` 环境变量配置。

生产运行：

```bash
pnpm build
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm start
```

新 Runtime 默认使用 `.data/kaguya.sqlite`。历史的 `.data/kaguya-api.sqlite` 和 `.data/kaguya-bot.sqlite` 不会被读取、合并或删除。

## 常用命令

| 命令               | 用途                                          |
| ------------------ | --------------------------------------------- |
| `pnpm dev`         | 以开发模式启动唯一 Kaguya Server 和内嵌 Vite  |
| `pnpm build`       | 构建 packages、Server 和 Web 产物             |
| `pnpm start`       | 以生产模式启动构建后的唯一 Server             |
| `pnpm demo`        | 显式运行确定性的模块消息链                    |
| `pnpm test`        | 运行单元和集成测试                            |
| `pnpm typecheck`   | 检查全部 TypeScript project references 和 Web |
| `pnpm lint`        | 运行 ESLint                                   |
| `pnpm prompt:test` | 在阻断外部出口后验证四类 Prompt 结构          |

`pnpm demo` 写入 `.data/kaguya-demo.sqlite`，与 Server 数据库隔离。

## 统一配置

| 环境变量                             | 默认值                | 说明                                   |
| ------------------------------------ | --------------------- | -------------------------------------- |
| `KAGUYA_GATEWAY_TOKEN`               | 无                    | 可选；未设时启动自动生成并分发给 Web UI |
| `KAGUYA_HOST`                        | `127.0.0.1`           | 唯一服务监听地址                       |
| `KAGUYA_PORT`                        | `3000`                | 唯一服务监听端口                       |
| `KAGUYA_DATABASE_PATH`               | `.data/kaguya.sqlite` | Runtime SQLite 文件                    |
| `KAGUYA_CORS_ORIGINS`                | 空                    | 逗号分隔的允许来源；同源 UI 不需要配置 |
| `KAGUYA_TRUST_PROXY`                 | 空                    | 逗号分隔的可信代理地址/CIDR            |
| `KAGUYA_RATE_LIMIT_MAX`              | `30`                  | 每个限流窗口的请求数                   |
| `KAGUYA_RATE_LIMIT_WINDOW_MS`        | `60000`               | 限流窗口毫秒数                         |
| `KAGUYA_CONFIG_ROOT`                 | `.data/kaguya-config` | profile registry；含 provider 与 tier  |
| `KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS` | 空                    | 逗号分隔的平台 ID；空值表示不限制      |
| `KAGUYA_GATEWAY_ALLOWLIST_USER_IDS`  | 空                    | 逗号分隔的用户 ID；空值表示不限制      |
| `KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS` | 空                    | 逗号分隔的群组 ID；空值表示不限制      |
| `KAGUYA_NAPCAT_ENABLED`              | `false`               | 是否启用 NapCat                        |
| `KAGUYA_NAPCAT_WS_URL`               | 无                    | 启用 NapCat 时必填                     |
| `KAGUYA_NAPCAT_ACCESS_TOKEN`         | 无                    | NapCat access token                    |
| `KAGUYA_NAPCAT_SELF_ID`              | 无                    | 可选的预期机器人 ID                    |
| `KAGUYA_NAPCAT_RECONNECT_MS`         | `3000`                | 重连间隔                               |

Server 不从环境变量读取 provider key、base URL 或 model。检测到旧的 `KAGUYA_LLM_API_KEY`、`KAGUYA_LLM_BASE_URL` 或 `KAGUYA_LLM_MODEL` 会在启动前失败并提示迁移到 profile；错误不会包含变量值。直接嵌入 `KaguyaRuntime` 的测试和 demo 仍可注入确定性模型。

旧变量 `KAGUYA_API_HOST`、`KAGUYA_API_PORT`、`KAGUYA_API_DATABASE_PATH`、`KAGUYA_BOT_DATABASE_PATH` 会让启动直接失败，并提示改用统一变量。

日志变量见[环境变量参考](docs/reference/environment-variables.md)，执行链与脱敏边界见[运行时架构](docs/developers/architecture.md)。

## 仓库结构

```text
apps/server/        唯一 composition root：HTTP、Web、NapCat、Runtime、关闭流程
apps/web/           React/Vite 同源浏览器客户端
apps/demo/          确定性消息模块链的显式演示 runner
packages/runtime/   消息 ingress、模块装配、LLM execution 与 outbound transport
packages/engine/    EventBus 与 WorkflowEngine
packages/modules/   标准消息事件与最小 filter/LLM demo 模块
packages/database/  SQLite 迁移和 repositories
packages/llm/       LLM 调用、输出校验和 trace
packages/prompt/    Prompt 编译与 provenance
packages/logger/    统一日志、上下文与脱敏
packages/schema/    跨包数据契约
packages/sdk/       事件、模块、节点与工作流定义 API
```

## 文档

- [文档站首页](docs/index.md)
- [安装与启动](docs/guide/installation.md)
- [配置 Kaguya](docs/guide/configuration.md)
- [Web UI](docs/guide/webui.md)
- [运行时架构](docs/developers/architecture.md)
- [HTTP API](docs/reference/http-api.md)
- [环境变量](docs/reference/environment-variables.md)
- [配置包说明](packages/config/README.md)
- [贡献指南](CONTRIBUTING.md)

## 当前边界

模块是受信任的同进程代码，可向任意已注册 transport destination 发消息。系统没有持久事件队列、重试、去重、热更新或模块沙箱。HTTP 消息只携带文本；`202 accepted` 不返回模型回答，也不会自动推导 Web 出站地址。旧配置索引和旧 SQLite 格式会被明确拒绝，不会自动迁移或删除。
