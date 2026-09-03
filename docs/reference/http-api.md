---
title: HTTP API
description: Kaguya 统一 Server 的路由、认证、请求和错误协议。
---

# HTTP API

`apps/server` 在一个 Fastify 实例中提供 Web UI、健康检查、OpenAPI、配置管理和消息入口。默认地址是 `http://127.0.0.1:3000`。

## 路由

**`GET /` 与静态资源** — 无需认证，提供 Web UI。

**`GET /healthz`** — 无需认证、不限流，返回 `{"status":"ok"}`。

**`GET /api/v1/openapi.json`** — 无需认证、不限流，返回 OpenAPI 3 描述。

**`GET /api/v1/setup`** — 无需认证、不限流，返回配置 readiness 状态（不含 Provider 密钥或完整 profile），并附带本实例分发的网关 token。

**`GET /api/v1/gateway/token`** — 无需认证、不限流，返回本实例分发的网关 token。

**`GET /api/v1/profiles`** — 需要 Bearer Token，返回 Profile 摘要与全局 selected Profile。

**`POST /api/v1/profiles`** — 需要 Bearer Token，创建一个未选中的空 Profile。

**`GET /api/v1/profiles/:profileId`** — 需要 Bearer Token，返回包含敏感配置的完整 Profile。

**`PUT /api/v1/profiles/:profileId`** — 需要 Bearer Token，完整替换一个 Profile。

**`PUT /api/v1/profiles/selection`** — 需要 Bearer Token，修改全局 selected Profile。

**`DELETE /api/v1/profiles/:profileId`** — 需要 Bearer Token，删除非 `default`、非 selected Profile。

**`POST /api/v1/messages`** — 需要 Bearer Token，校验并把一条 Web 文本消息交给 gateway 后台分发。

生产 SPA fallback 只处理接受 `text/html` 的 GET 页面请求，显式排除 `/api/*` 与 `/healthz`。未知 API 返回结构化 `404 not_found`。

## Bearer 认证

受保护接口使用：

::: code-group

```http [Authorization Header ~vscode-icons:file-type-http~]
Authorization: Bearer replace-with-at-least-16-characters
```

:::

认证发生在业务 schema 校验之前。认证和未认证请求使用不同的限流 key，避免未认证流量消耗已认证配额。

未显式设置 `KAGUYA_GATEWAY_TOKEN` 时，可先通过 `GET /api/v1/gateway/token` 读取当前实例的 token。

## 查询配置状态

`GET /api/v1/setup` 的 `data.status` 可能是 `setup_required`、`review_required`、`restart_required`、`ready` 或 `invalid`。响应不包含 API Key 或完整 profile，包含本实例分发的网关 token。

## 管理配置

当前代码不提供 `POST /api/v1/setup`。首次配置与后续修改统一通过细粒度 Profile API 完成；请求示例、完整替换语义与删除限制见[Profile API](./profile-api)。

## 提交消息

请求体只允许 `text` 字段。文本必须非空，trim 后不能只剩空白，最多 131072 个 Unicode code point；整个请求体最多 256 KiB。

::: code-group

```bash [curl ~vscode-icons:file-type-shell~]
curl http://127.0.0.1:3000/api/v1/messages \
  -H "Authorization: Bearer replace-with-at-least-16-characters" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: example-1" \
  -d '{"text":"Hello"}'
```

```json [202 响应 ~vscode-icons:file-type-json~]
{
  "data": {
    "status": "accepted",
    "requestId": "example-1"
  }
}
```

:::

`202 accepted` 只表示 Web gateway 已接受消息。gateway 随后以 `web:${requestId}` 作为 traceId，在后台异步调用 Runtime；响应不等待 dispatch、模型调用或出站投递完成。当前接口没有回复查询或 SSE。

## 错误格式

::: code-group

```json [错误响应 ~vscode-icons:file-type-json~]
{
  "error": {
    "code": "invalid_request",
    "message": "Request validation failed",
    "requestId": "example-1"
  }
}
```

:::

**`unauthorized` / 401** — Bearer Token 缺失或错误。

**`invalid_request` / 400** — JSON 或 schema 不合法。

**`configuration_invalid` / 400** — Profile 输入不完整、引用不一致或不满足 readiness。

**`configuration_unavailable` / 409** — 配置仓库损坏或不可安全访问。

**`not_found` / 404** — 路由不存在。

**`rate_limited` / 429** — 超过来源限流。

**`request_rejected` / 413 或 415** — Fastify 在进入 Runtime 前拒绝请求。

**`configuration_setup_required` / 503** — selected Profile 未 ready，Runtime ingress 未启动。

**`core_unavailable` / 503** — 测试或嵌入场景没有配置 Runtime dispatcher。

**`internal_error` / 500** — Runtime dispatch 或 Server 内部失败。

## Request ID

合法 `X-Request-Id` 长度为 1 至 128 个 ASCII 字符。首字符必须是字母或数字，其余仅允许字母、数字、点、下划线、冒号和连字符。非法值会被 UUID 替换。

HTTP 日志不记录 Authorization、body、query 或消息正文。生产部署仍需在边界层配置 TLS、连接数和超时。
