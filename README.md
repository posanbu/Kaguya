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

`KAGUYA_CONFIG_ROOT` 指向权限受保护的 Profile Registry；未设置时使用 `.data/kaguya-config`。端口、网关令牌、数据库、白名单、NapCat、日志和模型参数全部写入 selected Profile。启动前会执行统一配置校验；校验失败时记录 `configuration.validation.failed`，向终端输出字段路径和修复建议，并以非零状态退出，不启动 HTTP/Web UI、Runtime 或平台 ingress。初始化格式与密钥边界见 [`@kaguya/config`](packages/config/README.md)。

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

运行参数位于 Profile 的 `runtime` 字段；NapCat 位于 `platforms` 的 `type: "napcat"` 条目；Provider、模型层级、白名单和插件也由同一个 selected Profile 管理。Web UI 是内建平台，不计入外部平台数量；至少一个已启用的非 Web 平台是启动硬条件。

环境变量只保留 `KAGUYA_CONFIG_ROOT`，用于覆盖 Profile 根目录。其余旧服务、白名单、NapCat、日志和模型环境变量不会被读取或迁移，完整说明见[环境变量参考](docs/reference/environment-variables.md)。

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
