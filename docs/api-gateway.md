# 应用 API 网关

`apps/api` 是 Kaguya 的第一阶段应用 API 网关。它把浏览器或其他应用客户端与 `@kaguya/llm` 的 OpenAI-compatible 调用服务隔离开，并提供统一的入口认证、请求校验、限流、CORS、供应商白名单和错误响应。

当前 `POST /api/v1/llm/chat` 只用于测试模型配置和供应商连通性，不是正式聊天工作流入口。它不会调用 `dispatchEvent`，也不会创建会话、写入 `event_runs` 或 `llm_traces`。

## 技术选型

网关使用 Fastify 5 及其官方插件：

| 库                    | 用途                      | 选择原因                                                      |
| --------------------- | ------------------------- | ------------------------------------------------------------- |
| `fastify`             | HTTP 服务、路由和生命周期 | TypeScript 支持成熟，插件边界清晰，适合逐步加入认证和流式接口 |
| `@fastify/cors`       | 浏览器跨域策略            | 由服务端显式控制允许的 UI origin                              |
| `@fastify/rate-limit` | 按来源 IP 限流            | 在进入供应商调用前保护网关和模型预算                          |
| `@fastify/swagger`    | OpenAPI 文档              | 让后续 Web UI 可以生成或校验 API client                       |

模型调用继续复用仓库已有、基于原生 `fetch` 的 `OpenAiCompatibleLlmService`，网关不重复实现供应商协议、超时和重试。正式工作流使用的 `KaguyaLlmClient` 才以 Vercel AI SDK 作为模型抽象。

## AstrBot 参考

实现前参考了 AstrBot `f9c6129b9eecdd0a5c4069954baffc27bea02a0a` 的以下边界：

- `astrbot/dashboard/api/app.py`：应用工厂、服务注入和统一错误处理；
- `astrbot/dashboard/api/router.py`：统一 `/api/v1` 路由前缀；
- `astrbot/dashboard/api/auth.py`：JWT/API key 与权限 scope；
- `astrbot/dashboard/api/chat.py`：REST 与 SSE 路由；
- `astrbot/dashboard/services/chat_service.py`：独立于 SSE 连接的 run 状态、快照、心跳和重连；
- `astrbot/core/platform/sources/webchat/webchat_queue_mgr.py`：有界请求/会话队列和慢订阅者处理。

Kaguya 当前先采用应用工厂、依赖注入、版本化路由和统一错误结构。AstrBot 的持久 run、SSE 重连及有界队列适合下一阶段；当前模型接口不支持流式输出，因此本阶段不伪造 SSE。

## 启动

开发模式：

```powershell
. .\scripts\use-kaguya-env.ps1
$env:KAGUYA_GATEWAY_TOKEN = "replace-with-at-least-16-characters"
pnpm api:dev
```

`pnpm api:dev` 会先按 workspace 拓扑构建 `@kaguya/schema`、`@kaguya/llm` 和 `@kaguya/api`，再从 TypeScript 入口启动网关，避免依赖缺失或陈旧的 `dist`。

生产构建后启动：

```powershell
pnpm build
$env:KAGUYA_GATEWAY_TOKEN = "replace-with-at-least-16-characters"
pnpm api
```

## 配置

| 环境变量                         | 默认值                                        | 说明                                                       |
| -------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `KAGUYA_GATEWAY_TOKEN`           | 无                                            | 必填，至少 16 个字符；客户端用 Bearer token 访问受保护接口 |
| `KAGUYA_API_HOST`                | `127.0.0.1`                                   | 监听地址                                                   |
| `KAGUYA_API_PORT`                | `3000`                                        | 监听端口                                                   |
| `KAGUYA_CORS_ORIGINS`            | `http://localhost:5173,http://127.0.0.1:5173` | 逗号分隔的允许来源；设为空可关闭 CORS                      |
| `KAGUYA_LLM_ALLOWED_HOSTS`       | `api.openai.com`                              | 逗号分隔的模型供应商 hostname 精确白名单                   |
| `KAGUYA_LLM_ALLOW_INSECURE_HTTP` | `false`                                       | 是否显式允许向 HTTP provider 发送凭证和 Prompt             |
| `KAGUYA_LLM_REQUEST_TIMEOUT_MS`  | `300000`                                      | 单次模型调用总 deadline；允许 1000 到 900000 毫秒          |
| `KAGUYA_TRUST_PROXY`             | 空                                            | 逗号分隔的可信反向代理地址或 CIDR；为空时忽略转发 IP       |
| `KAGUYA_RATE_LIMIT_MAX`          | `30`                                          | 时间窗口内每个来源 IP 的最大请求数                         |
| `KAGUYA_RATE_LIMIT_WINDOW_MS`    | `60000`                                       | 限流窗口，单位毫秒                                         |

## 接口

| 方法和路径                 | 认证         | 用途                                |
| -------------------------- | ------------ | ----------------------------------- |
| `GET /healthz`             | 无           | 存活检查                            |
| `GET /api/v1/openapi.json` | 无           | OpenAPI 文档                        |
| `POST /api/v1/llm/chat`    | Bearer token | 测试一次 OpenAI-compatible 模型调用 |

调用示例：

```bash
curl http://127.0.0.1:3000/api/v1/llm/chat \
  -H "Authorization: Bearer replace-with-at-least-16-characters" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "provider-api-key",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5",
    "systemPrompt": "You are a helpful assistant.",
    "userPrompt": "Hello"
  }'
```

成功响应以 `{ "data": ... }` 包装。失败响应使用 `{ "error": { "code", "message", "requestId", ... } }`，主要错误码包括 `unauthorized`、`invalid_request`、`provider_not_allowed`、`provider_url_rejected`、`rate_limited`、`llm_provider_error` 和 `internal_error`。

## 安全边界

- 网关 token 与模型供应商 API key 是两套凭证；前者放在请求头，后者当前随模型测试请求传入。
- Bearer 认证在 body 解析和 schema 校验前执行，未认证调用者不能用错误响应探测请求结构。
- 已认证与未认证流量使用独立限流桶，失败认证不会耗尽合法调用额度。
- 服务不会记录 API key 或供应商错误的原始请求体。
- 自定义 `baseUrl` 的 hostname 必须精确命中服务端白名单，且 URL 不允许内嵌用户名或密码。
- 模型 URL 默认只允许 HTTPS；服务端开关开启后，所有白名单 host 都可使用 HTTP，并不会自动限制为 loopback，因此生产环境应保持关闭。底层请求禁止自动跟随重定向，避免把自定义鉴权头带到未经批准的地址。
- 自定义供应商鉴权头只允许 `Authorization`、`api-key` 或 `x-api-key`。
- API key 中的 HTTP header 控制字符会返回 `400 invalid_request`。
- 请求中的未知字段会直接返回 `invalid_request`，不会被静默忽略。
- 结构化失败日志只记录错误类别、状态码和尝试次数，不记录供应商原始错误消息。
- provider 原始错误消息和 cause 不返回客户端；响应只保留规范化消息、`kind`、`attempts`、`providerStatus` 和 `requestId`。
- 客户端断连或服务端总 deadline 到期会取消模型请求；指数退避的单次等待不超过 60 秒。
- 只有 `KAGUYA_TRUST_PROXY` 明确列出的代理才能影响客户端 IP 和限流 key，不能对公网入口无条件开启。
- 请求体上限为 256 KiB。生产部署仍应在反向代理层配置 TLS、总连接数、请求超时和可信代理。

## 下一阶段

正式聊天入口需要增加会话 API，将请求转换为 Kaguya 事件并调用 `dispatchEvent`；run 状态需要持久化，生成任务不能依附单个 SSE 连接。之后再加入可重连 SSE、心跳、取消、有界订阅队列以及带 scope 的用户/管理员认证。
