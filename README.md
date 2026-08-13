# Kaguya

Kaguya 是一个以事件和有向工作流为核心的 TypeScript AI Bot Runtime。仓库现在只有一个长期运行的应用入口：`apps/server` 在同一进程、同一端口上提供 Web UI、HTTP API 和可选 NapCat 连接，并通过唯一的 `@kaguya/runtime` 处理消息。

核心能力包括：

- `KaguyaRuntime` 统一持有 SQLite、EventBus、WorkflowEngine、PromptCompiler、LLM client 和工作流装配；
- Web 与 NapCat 消息进入同一条 message workflow、同一数据库和同一会话历史；
- Fastify 同端口提供 UI、`/healthz`、OpenAPI 和受 Bearer Token 保护的消息 API；
- 开发环境由 Fastify 内挂 Vite middleware，HMR 不需要第二个 Web 服务；
- NapCat 可选且独立重连，断线不会影响 HTTP 和 Web UI；
- 开发默认 pretty 日志、生产默认 JSON，并统一关联 request、trace、event 和 workflow node；
- heartbeat 与 memory 工作流仍保留，但只由 `pnpm demo` 显式运行，Server 不注册 scheduler。

## 快速开始

需要 Node.js 24.18.0 和 pnpm 11.9.0。

```bash
corepack enable
pnpm install
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
pnpm dev
```

打开 `http://127.0.0.1:3000`。页面和 API 使用同源路径；浏览器只需要填写 Bearer Token 和会话 ID。

生产运行：

```bash
pnpm build
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
pnpm start
```

新 Runtime 默认使用 `.data/kaguya.sqlite`。历史的 `.data/kaguya-api.sqlite` 和 `.data/kaguya-bot.sqlite` 不会被读取、合并或删除。

## 常用命令

| 命令               | 用途                                                 |
| ------------------ | ---------------------------------------------------- |
| `pnpm dev`         | 以开发模式启动唯一 Kaguya Server 和内嵌 Vite         |
| `pnpm build`       | 构建 packages、Server 和 Web 产物                    |
| `pnpm start`       | 以生产模式启动构建后的唯一 Server                    |
| `pnpm demo`        | 显式运行 message、heartbeat、memory 三条确定性工作流 |
| `pnpm test`        | 运行单元和集成测试                                   |
| `pnpm typecheck`   | 检查全部 TypeScript project references 和 Web        |
| `pnpm lint`        | 运行 ESLint                                          |
| `pnpm prompt:test` | 在阻断外部出口后验证四类 Prompt 结构                 |

`pnpm demo` 写入 `.data/kaguya-demo.sqlite`，与 Server 数据库隔离。Server 本身不会定时或自动触发 heartbeat/memory。

## 统一配置

| 环境变量                      | 默认值                | 说明                                   |
| ----------------------------- | --------------------- | -------------------------------------- |
| `KAGUYA_GATEWAY_TOKEN`        | 无                    | 必填，至少 16 个字符                   |
| `KAGUYA_HOST`                 | `127.0.0.1`           | 唯一服务监听地址                       |
| `KAGUYA_PORT`                 | `3000`                | 唯一服务监听端口                       |
| `KAGUYA_DATABASE_PATH`        | `.data/kaguya.sqlite` | Runtime SQLite 文件                    |
| `KAGUYA_CORS_ORIGINS`         | 空                    | 逗号分隔的允许来源；同源 UI 不需要配置 |
| `KAGUYA_TRUST_PROXY`          | 空                    | 逗号分隔的可信代理地址/CIDR            |
| `KAGUYA_RATE_LIMIT_MAX`       | `30`                  | 每个限流窗口的请求数                   |
| `KAGUYA_RATE_LIMIT_WINDOW_MS` | `60000`               | 限流窗口毫秒数                         |
| `KAGUYA_LLM_API_KEY`          | 无                    | OpenAI-compatible LLM API key          |
| `KAGUYA_LLM_BASE_URL`         | OpenAI 默认地址       | 可选的 OpenAI-compatible base URL      |
| `KAGUYA_LLM_MODEL`            | 无                    | OpenAI-compatible 模型名               |
| `KAGUYA_NAPCAT_ENABLED`       | `false`               | 是否启用 NapCat                        |
| `KAGUYA_NAPCAT_WS_URL`        | 无                    | 启用 NapCat 时必填                     |
| `KAGUYA_NAPCAT_ACCESS_TOKEN`  | 无                    | NapCat access token                    |
| `KAGUYA_NAPCAT_SELF_ID`       | 无                    | 可选的预期机器人 ID                    |
| `KAGUYA_NAPCAT_RECONNECT_MS`  | `3000`                | 重连间隔                               |

如果没有配置 `KAGUYA_LLM_API_KEY` 和 `KAGUYA_LLM_MODEL`，Runtime 会继续使用确定性本地模型，主要用于测试和演示。生产接 QQ 时应同时配置这两个变量，让 route/reply 节点由真实 LLM 判断是否自然发言以及回复内容。

旧变量 `KAGUYA_API_HOST`、`KAGUYA_API_PORT`、`KAGUYA_API_DATABASE_PATH`、`KAGUYA_BOT_DATABASE_PATH` 会让启动直接失败，并提示改用统一变量。

日志变量和事件表见 [结构化日志](docs/logging.md)。

## 仓库结构

```text
apps/server/        唯一 composition root：HTTP、Web、NapCat、Runtime、关闭流程
apps/web/           React/Vite 同源浏览器客户端
apps/demo/          heartbeat/memory/message 的显式演示 runner
packages/runtime/   消息 dispatch、三条工作流、共用节点和共享运行组件
packages/engine/    EventBus 与 WorkflowEngine
packages/database/  SQLite 迁移和 repositories
packages/llm/       LLM 调用、输出校验和 trace
packages/prompt/    Prompt 编译与 provenance
packages/logger/    统一日志、上下文与脱敏
packages/schema/    跨包数据契约
packages/sdk/       事件、节点与工作流定义 API
```

## 文档

- [架构说明](docs/architecture.md)
- [HTTP API 与统一 Server](docs/api-gateway.md)
- [Web UI](docs/web-ui.md)
- [结构化日志](docs/logging.md)
- [LLM Client](docs/llm-client.md)
- [配置包说明](packages/config/README.md)
- [贡献指南](CONTRIBUTING.md)

## 当前边界

主程序继续使用并发安全、可重复的确定性模型。真实 provider/config profile 接线、scheduler、SSE、消息查询、持久队列和新的平台 adapter 不在本次 Runtime 收束范围内。HTTP `202 accepted` 表示同步 dispatch 已完成并被入口接受，但接口仍不返回模型回答；平台消息在工作流内通过对应 sender 投递回复。
