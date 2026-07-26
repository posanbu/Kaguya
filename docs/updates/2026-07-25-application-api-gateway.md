# 2026-07-25 应用 API 网关更新说明

本次更新把 `@kaguya/api` 收敛为应用消息入口：Web UI 只提交会话标识和消息文本，网关完成认证、限流、严格校验并调用注入的 `MessageIngress`。模型、provider、API 地址和凭证不再由客户端请求决定。

同时，按照 [Issue #1](https://github.com/posanbu/Kaguya/issues/1)，OpenAI-compatible 模型调用继续由 `@kaguya/llm` 内部的 Vercel AI SDK adapter 承担，网关不再提供或维护第二套模型调用接口。

## 新增与调整

- 保留 `GET /healthz` 存活检查和 `GET /api/v1/openapi.json` OpenAPI 文档；
- 新增 `POST /api/v1/messages`，请求体只接受 `sessionId` 与 `text`；
- 新增 `MessageIngress.enqueue({ sessionId, text, requestId })` 依赖注入边界；
- 成功入队返回 HTTP `202` 和 `{ status: "accepted", requestId }`；
- 未注入 ingress 时返回 HTTP `503 core_unavailable`；
- ingress 内部失败统一脱敏为 HTTP `500 internal_error`；
- 删除 `POST /api/v1/llm/chat`，旧路径现在返回 `404`；
- 从网关删除 provider URL、API key、模型选择、LLM 超时和 provider allowlist 配置；
- 保留 Bearer 认证、CORS、按客户端 IP 限流、可信代理、256 KiB 请求体上限和统一错误结构。

## Issue #1 SDK 边界

`@kaguya/llm` 的 OpenAI-compatible adapter 使用 `@ai-sdk/openai-compatible` 创建动态 provider，并通过 `ai` 的 `generateText` 执行调用。请求序列化、模型响应解析、usage 解析和 SDK 重试由现有 SDK 负责，Kaguya 只维护自身的输入、错误与 trace 契约。

`@kaguya/api` 不依赖 `@kaguya/llm`。网关只负责 HTTP ingress，不接收 `apiKey`、`baseUrl` 或 `model`，也不负责选择 provider 与工作流。这样既满足 Issue #1 的“模型 API 使用现有 SDK”要求，也避免把敏感 provider 配置暴露成面向 UI 的透传代理。本次没有引入另一套 xsAI 调用实现。

底层 adapter 的详细契约见 [OpenAI-compatible LLM 通用接口](../openai-compatible-llm.md)。该 adapter 可用于内部装配与独立连通性测试，但不是 Web UI 后端路由。

## API 契约

### 请求

```http
POST /api/v1/messages
Authorization: Bearer <KAGUYA_GATEWAY_TOKEN>
Content-Type: application/json
```

```json
{
  "sessionId": "session-1",
  "text": "Hello"
}
```

- `sessionId` trim 后必须非空，最长 256 个字符；
- `text` 必须非空且 trim 后非空，最长 131072 个字符；
- schema 为 strict，任何额外字段都会返回 `400 invalid_request`；
- 认证先于 body 解析和校验执行。

### 已接受

```http
HTTP/1.1 202 Accepted
```

```json
{
  "data": {
    "status": "accepted",
    "requestId": "request-id"
  }
}
```

`202` 仅确认注入的 ingress 已接受 `enqueue`，不代表 core 已消费消息、工作流已完成或模型已返回结果。

### Core 未接线

```http
HTTP/1.1 503 Service Unavailable
```

```json
{
  "error": {
    "code": "core_unavailable",
    "message": "Core message ingress is not configured",
    "requestId": "request-id"
  }
}
```

当前 `server.ts` 没有注入 `MessageIngress`，所以这是通过 `pnpm api` 或 `pnpm api:dev` 启动后合法消息请求的当前结果。

## 测试发现与修复

| 问题                                 | 修复或覆盖                                                     |
| ------------------------------------ | -------------------------------------------------------------- |
| body 校验早于认证                    | 认证移到 `onRequest`，未认证畸形请求统一返回 `401`             |
| 失败认证占用合法调用配额             | 按认证状态和客户端 IP 分离限流 key                             |
| Fastify 静默删除未知字段             | 关闭 AJV `removeAdditional`，未知字段返回 `invalid_request`    |
| UI 可提交 provider 凭证和模型策略    | strict schema 只允许 `sessionId` 与 `text`                     |
| 空白消息可进入 core                  | Zod 层要求两个字段 trim 后非空                                 |
| 已删除的模型路由仍可能出现在 OpenAPI | 回归测试同时断言旧路径返回 `404` 且 OpenAPI 不含 provider 字段 |
| core 尚未接线时可能伪装成成功        | 缺少 ingress 时显式返回 `503 core_unavailable`                 |
| ingress 异常细节可能泄漏给客户端     | 统一返回 `500 internal_error`，不暴露内部异常消息              |
| 未受信代理可伪造客户端 IP            | 只接受 `KAGUYA_TRUST_PROXY` 明确列出的代理地址或 CIDR          |

## 网关配置

| 环境变量                      | 默认值                                        | 用途                              |
| ----------------------------- | --------------------------------------------- | --------------------------------- |
| `KAGUYA_GATEWAY_TOKEN`        | 无                                            | 网关 Bearer token，至少 16 个字符 |
| `KAGUYA_API_HOST`             | `127.0.0.1`                                   | HTTP 监听地址                     |
| `KAGUYA_API_PORT`             | `3000`                                        | HTTP 监听端口                     |
| `KAGUYA_CORS_ORIGINS`         | `http://localhost:5173,http://127.0.0.1:5173` | 允许的浏览器 origin 列表          |
| `KAGUYA_TRUST_PROXY`          | 空                                            | 可信反向代理地址或 CIDR 列表      |
| `KAGUYA_RATE_LIMIT_MAX`       | `30`                                          | 每个限流窗口的最大请求数          |
| `KAGUYA_RATE_LIMIT_WINDOW_MS` | `60000`                                       | 限流窗口毫秒数                    |

旧的模型 provider 网关环境变量均已删除。完整启动方式、响应结构和安全说明见 [应用 API 网关](../api-gateway.md)。

## 兼容性变化

- 旧模型直连路由不提供兼容别名；
- Web UI 请求必须改为 `POST /api/v1/messages` 并只发送 `sessionId` 与 `text`；
- `apiKey`、`baseUrl`、`model` 以及其他额外字段会被拒绝，不能再通过 HTTP ingress 动态路由模型；
- 调用方必须把 `202 accepted` 与最终处理完成区分开；
- 部署方必须在 composition root 注入 `MessageIngress`，否则合法消息会收到 `503`；
- provider 和模型策略应从服务端配置与 core 读取，并通过 `@kaguya/llm` SDK adapter 执行。

## 验证范围

- OpenAPI 只公开消息 ingress，不包含旧模型路由和 provider 配置字段；
- 旧模型路由返回 `404`；
- Bearer 认证先于 body 解析，且 scheme 大小写不敏感；
- strict schema 拒绝模型字段、provider 字段、空白消息和其他额外字段；
- 注入 ingress 时返回 `202` 并传递 trim 后的 `sessionId`、原始 `text` 与 `requestId`；
- 未注入 ingress 时返回 `503`，ingress 抛错时返回脱敏的 `500`；
- 已认证与未认证限流桶分离，转发 IP 只在显式可信代理下生效。

## 当前边界

本次只实现 validation + enqueue boundary。core dispatcher、持久队列、consumer、工作流 handoff、持久 run、结果查询、可重连 SSE、取消 API 和正式 Web UI 均未实现。模型 SDK adapter 已存在，但需要在服务端 core 策略确定模型与 provider 后才能接入正式消息处理链路。
