---
title: HTTP API
description: Kaguya 统一 Server 的路由、认证、Profile 与消息协议。
---

# HTTP API

`apps/server` 在一个 Fastify 实例中提供 Web UI、健康检查、OpenAPI、配置管理和消息入口。默认地址是 `http://127.0.0.1:3000`。

## 公共路由

**`GET /` 与静态资源** — 无需认证，提供 Web UI。

**`GET /healthz`** — 无需认证、不限流，返回 `{"status":"ok"}`。

**`GET /api/v1/openapi.json`** — 无需认证、不限流，返回 OpenAPI 3 描述。

**`GET /api/v1/setup`** — 需要 Bearer Token，返回配置 readiness 状态，不含 Provider 密钥或完整 profile。

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

认证发生在业务 schema 校验之前。认证和未认证请求使用不同限流 key，避免未认证流量消耗已认证配额。

Server 每次启动生成一个新的全权限 token，成功监听后通过 `Kaguya access URL` 的 `#gatewayToken=` fragment 输出。该 token 同时授权 setup、management 和 messages 范围；重启后旧 token 返回 `401 unauthorized`。

## 管理配置

当前代码不提供 `POST /api/v1/setup`。首次配置与后续修改统一通过细粒度 Profile API 完成；请求示例、完整替换语义与删除限制见[Profile API](./profile-api)。

## 提交消息

`POST /api/v1/messages` 需要 Bearer Token。请求体只允许 `text` 字段：文本必须非空，trim 后不能只剩空白，最多 131072 个 Unicode code point；整个请求体最多 256 KiB。

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

**`invalid_request` / 400** — JSON、路径参数或 schema 不合法。

**`profile_invalid` / 400** — 已通过 HTTP JSON/schema 读取、但被 Profile 管理逻辑拒绝的输入。

**`profile_not_found` / 404** — 请求的 Profile 不存在。

**`configuration_invalid` / 400** — Profile 输入不完整、引用不一致或不满足 readiness。

**`profile_in_use` / 409** — 不能删除当前 `selectedProfileId` 指向的 Profile。

**`configuration_unavailable` / 409** — 此 HTTP application 没有注入 Profile management facade。这是嵌入或测试构造边界，不表示配置目录损坏；配置目录损坏或无法安全访问会在 Server 启动阶段失败，而不会以此路由错误继续运行。

**`not_found` / 404** — 未知 HTTP 路由。

**`rate_limited` / 429** — 超过来源限流。

**`request_rejected` / 413 或 415** — Fastify 在进入 Runtime 前拒绝请求。

**`configuration_setup_required` / 503** — selected Profile 未 ready，Runtime ingress 未启动。

**`core_unavailable` / 503** — 嵌入或测试场景没有提供 Runtime ingress。

**`internal_error` / 500** — Server 内部失败。

## Request ID 与日志

合法 `X-Request-Id` 长度为 1 至 128 个 ASCII 字符。首字符必须是字母或数字，其余仅允许字母、数字、点、下划线、冒号和连字符；非法值会被 UUID 替换。

HTTP 日志不记录 Authorization、body、query 或消息正文。生产部署仍需在边界层配置 TLS、连接数和超时。
