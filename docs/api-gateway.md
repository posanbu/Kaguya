# 应用 API 网关

`apps/api` 是 Kaguya 的第一阶段应用 API 网关。它接收应用客户端提交的消息，完成认证、限流和参数校验，再通过依赖注入的 `MessageIngress` 把消息交给 core。网关不选择模型、provider 或工作流，也不直接调用 LLM。

旧的模型直连路由已删除。客户端不能通过网关提交 `apiKey`、`baseUrl` 或 `model`；这些敏感配置和执行策略应由服务端配置层与 core 管理。

## 技术选型

网关使用 Fastify 5 及其官方插件：

| 库或边界              | 用途                      | 选择原因                                                      |
| --------------------- | ------------------------- | ------------------------------------------------------------- |
| `fastify`             | HTTP 服务、路由和生命周期 | TypeScript 支持成熟，插件边界清晰，适合组合认证和后续流式接口 |
| `@fastify/cors`       | 浏览器跨域策略            | 由服务端显式控制允许的 UI origin                              |
| `@fastify/rate-limit` | 按来源 IP 限流            | 在请求进入 core 前保护网关资源                                |
| `@fastify/swagger`    | OpenAPI 文档              | 让后续 Web UI 可以生成或校验 API client                       |
| `MessageIngress`      | core 消息入站抽象         | 让 HTTP 层只依赖 `enqueue` 契约，不耦合 dispatcher 或队列实现 |

按照 [Issue #1](https://github.com/posanbu/Kaguya/issues/1)，`@kaguya/llm` 内部的 OpenAI-compatible adapter 使用 Vercel AI SDK，由 `@ai-sdk/openai-compatible` 创建 provider，并由 `ai` 的 `generateText` 处理模型调用。`@kaguya/api` 不导入 `@kaguya/llm`，也没有手写另一套 provider HTTP 客户端；SDK adapter 是内部模型边界，不是暴露给 Web UI 的动态模型代理。

## AstrBot 参考

实现前参考了 AstrBot `f9c6129b9eecdd0a5c4069954baffc27bea02a0a` 的以下边界：

- `astrbot/dashboard/api/app.py`：应用工厂、服务注入和统一错误处理；
- `astrbot/dashboard/api/router.py`：统一 `/api/v1` 路由前缀；
- `astrbot/dashboard/api/auth.py`：JWT/API key 与权限 scope；
- `astrbot/dashboard/api/chat.py`：REST 与 SSE 路由；
- `astrbot/dashboard/services/chat_service.py`：独立于 SSE 连接的 run 状态、快照、心跳和重连；
- `astrbot/core/platform/sources/webchat/webchat_queue_mgr.py`：有界请求/会话队列和慢订阅者处理。

Kaguya 当前采用应用工厂、依赖注入、版本化路由、统一错误结构和轻量的消息 ingress 边界。`MessageIngress` 只是接口，不等于已经实现队列；AstrBot 的持久 run、有界队列、consumer 和 SSE 重连仍属于后续阶段。

## 启动

开发模式：

```powershell
. .\scripts\use-kaguya-env.ps1
$env:KAGUYA_GATEWAY_TOKEN = "replace-with-at-least-16-characters"
pnpm api:dev
```

`pnpm api:dev` 会先按 workspace 拓扑构建 `@kaguya/api` 及其依赖，再从 TypeScript 入口启动网关。网关不再为了启动而构建或加载 `@kaguya/llm`。

生产构建后启动：

```powershell
pnpm build
$env:KAGUYA_GATEWAY_TOKEN = "replace-with-at-least-16-characters"
pnpm api
```

当前 `server.ts` 尚未注入 `MessageIngress`。因此启动后的健康检查、OpenAPI、认证和请求校验可用，但合法消息会返回 `503 core_unavailable`，直到 composition root 接入 core 实现。

## 配置

| 环境变量                      | 默认值                                        | 说明                                                     |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| `KAGUYA_GATEWAY_TOKEN`        | 无                                            | 必填，至少 16 个字符；客户端用 Bearer token 访问消息接口 |
| `KAGUYA_API_HOST`             | `127.0.0.1`                                   | 监听地址                                                 |
| `KAGUYA_API_PORT`             | `3000`                                        | 监听端口，允许 `1..65535`                                |
| `KAGUYA_CORS_ORIGINS`         | `http://localhost:5173,http://127.0.0.1:5173` | 逗号分隔的允许来源；设为空可关闭 CORS                    |
| `KAGUYA_TRUST_PROXY`          | 空                                            | 逗号分隔的可信反向代理地址或 CIDR；为空时忽略转发 IP     |
| `KAGUYA_RATE_LIMIT_MAX`       | `30`                                          | 每个来源在时间窗口内的最大请求数，允许 `1..10000`        |
| `KAGUYA_RATE_LIMIT_WINDOW_MS` | `60000`                                       | 限流窗口毫秒数，允许 `1000..3600000`                     |

网关没有模型 provider 相关环境变量。模型凭证、provider 地址和模型选择不属于 HTTP ingress 配置。

## 接口

| 方法和路径                 | 认证         | 用途                          |
| -------------------------- | ------------ | ----------------------------- |
| `GET /healthz`             | 无           | 存活检查                      |
| `GET /api/v1/openapi.json` | 无           | OpenAPI 文档                  |
| `POST /api/v1/messages`    | Bearer token | 校验消息并提交给 core ingress |

消息请求体只允许两个字段：

| 字段        | 约束                                                               |
| ----------- | ------------------------------------------------------------------ |
| `sessionId` | 字符串；trim 后非空；最长 256 个字符；入队时使用 trim 后的值       |
| `text`      | 字符串；非空且 trim 后非空；最长 131072 个字符；入队时保留原始空白 |

任何额外字段都会返回 `400 invalid_request`，包括 `apiKey`、`baseUrl` 和 `model`。

调用示例：

```bash
curl http://127.0.0.1:3000/api/v1/messages \
  -H "Authorization: Bearer replace-with-at-least-16-characters" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "session-1",
    "text": "Hello"
  }'
```

注入的 ingress 接受消息后，网关返回 HTTP `202`：

```json
{
  "data": {
    "status": "accepted",
    "requestId": "request-id"
  }
}
```

网关调用的契约为：

```ts
messageIngress.enqueue({
  sessionId,
  text,
  requestId,
});
```

`202` 只表示注入的 ingress 已接受本次 `enqueue`，不表示消息已经持久化、工作流已经执行或模型已经生成响应。当前生产启动入口没有注入 ingress，因此合法请求会返回 HTTP `503`：

```json
{
  "error": {
    "code": "core_unavailable",
    "message": "Core message ingress is not configured",
    "requestId": "request-id"
  }
}
```

失败响应统一使用 `{ "error": { "code", "message", "requestId" } }`。当前公开错误码包括：

| 错误码             | 典型状态码 | 含义                                |
| ------------------ | ---------- | ----------------------------------- |
| `unauthorized`     | `401`      | Bearer token 缺失或不正确           |
| `invalid_request`  | `400`      | JSON body 不符合严格 schema         |
| `core_unavailable` | `503`      | composition root 未配置消息 ingress |
| `rate_limited`     | `429`      | 来源超过限流配额                    |
| `request_rejected` | 其他 `4xx` | Fastify 拒绝了请求                  |
| `internal_error`   | `500`      | ingress 失败或网关发生未处理异常    |

## 安全边界

- Bearer 认证在 body 解析和 schema 校验前执行，未认证调用者不能通过校验错误探测请求结构。
- 已认证与未认证流量使用独立限流桶，失败认证不会耗尽合法调用额度。
- 请求 schema 严格拒绝未知字段，网关不会接收或记录 provider API key、URL 和模型名。
- ingress 内部异常不会回显给客户端，只返回规范化的 `internal_error`。
- `x-request-id` 会进入响应与 `MessageIngressCommand`，用于跨边界追踪。
- 只有 `KAGUYA_TRUST_PROXY` 明确列出的代理才能影响客户端 IP 和限流 key。
- 请求体上限为 256 KiB。生产部署仍应在反向代理层配置 TLS、连接数和请求超时。
- CORS 只限制浏览器来源，不能替代 Bearer 认证或服务端授权。

## 当前边界

当前实现只完成 HTTP validation + enqueue boundary。仓库尚未提供该边界背后的 core dispatcher、持久队列、consumer 或工作流 handoff，`server.ts` 也没有注入临时实现。下一阶段应先在 composition root 接入可测试、可观测的 core ingress，再设计持久 run、结果查询、可重连 SSE、取消和背压；模型与 provider 仍由服务端策略选择，而不是由 UI 请求决定。
