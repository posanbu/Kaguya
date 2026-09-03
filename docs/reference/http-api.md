---
title: HTTP API
description: Kaguya 统一 Server 的路由、认证、Profile 与消息协议。
---

# HTTP API

`apps/server` 在一个 Fastify 实例中提供 Web UI、健康检查、OpenAPI、Profile Registry 管理和 Web 消息入口。默认地址是 `http://127.0.0.1:3000`。

## 公共路由

**`GET /` 与静态资源** — 无需认证，提供 Web UI。

**`GET /healthz`** — 无需认证、不限流，返回 `{"status":"ok"}`。

**`GET /api/v1/openapi.json`** — 无需认证、不限流，返回 OpenAPI 3 描述。

**`GET /api/v1/setup`** — 无需认证、不限流，返回不含 Provider 密钥或 Gateway Token 的 readiness、`selectedProfileId` 与 Profile metadata。状态可能为 `setup_required`、`invalid`、`review_required`、`restart_required` 或 `ready`。

生产 SPA fallback 只处理接受 `text/html` 的 GET 页面请求，显式排除 `/api/*` 与 `/healthz`。未知 API 返回结构化 `404 not_found`。

## Bearer 认证

受保护接口使用：

::: code-group

```http [Authorization Header ~vscode-icons:file-type-http~]
Authorization: Bearer replace-with-at-least-16-characters
```

:::

认证发生在业务 schema 校验之前。认证和未认证请求使用不同限流 key，避免未认证流量消耗已认证配额。

首次配置使用终端展示的一次性 bootstrap Token；配置成功后，正式 Token 仅在成功响应中返回一次。

**`POST /api/v1/setup`** — 使用一次性 bootstrap Token 创建或修复默认 Profile。成功后返回正式 Token，并立即撤销 bootstrap 权限。

## 管理全局 Profile

Profile API 以 Registry 中唯一的 `selectedProfileId` 为运行时选择边界。所有以下路由都需要 Bearer Token：

**`GET /api/v1/profiles`** — 返回 Profile metadata 列表与当前 `selectedProfileId`。

**`POST /api/v1/profiles`** — 接收严格的 `{ "name": "..." }`，创建一个命名 Profile，但不会选中它。

**`PUT /api/v1/profiles/selection`** — 接收严格的 `{ "selectedProfileId": "..." }`，显式选择全局 Profile。

**`GET /api/v1/profiles/:profileId`** — 读取一个明确指定的 Profile。

**`PUT /api/v1/profiles/:profileId`** — 完整替换一个 Profile。请求需要 `name`、`ai`、`platforms`、`plugins` 与 `acknowledgedWarnings`。

**`DELETE /api/v1/profiles/:profileId`** — 删除一个非 `default` 且非当前选中的 Profile，成功时返回 `204`。

创建、替换或选择成功时返回 Profile 与 `restartRequired`。选中 Profile 的变更不会热加载；Server 只在下一次启动时读取它并构造共享模型解析器。

::: code-group

```json [选择全局 Profile ~vscode-icons:file-type-json~]
{
  "selectedProfileId": "default"
}
```

:::

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

Web 网关会正规化文本，并异步调用 `InformationIngress.submit()`。因此 `202 accepted` 表示 Server 已接收请求并开始提交，不表示 context 或入站原子已经持久化，也不表示 LLM、回复或投递已经完成。当前 HTTP API 没有回复查询或 SSE。

Runtime 成功处理时会由 Core 生成唯一 `informationId`，持久化 `core.runtime.context` 与入站原子后才广播给模块；该内部 ID 不会作为 HTTP `202` 的另一套响应身份暴露。

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

**`configuration_invalid` / 400** — Profile 输入不完整或不满足 readiness。

**`configuration_unavailable` / 409** — 配置仓库损坏或不可安全访问。

**`not_found` / 404** — 路由或 Profile 不存在。

**`rate_limited` / 429** — 超过来源限流。

**`request_rejected` / 413 或 415** — Fastify 在进入 Runtime 前拒绝请求。

**`configuration_setup_required` / 503** — 当前 selected Profile 未就绪，Runtime ingress 尚未启动。

**`core_unavailable` / 503** — 嵌入或测试场景没有提供 Runtime ingress。

**`internal_error` / 500** — Server 内部失败。

## Request ID 与日志

合法 `X-Request-Id` 长度为 1 至 128 个 ASCII 字符。首字符必须是字母或数字，其余仅允许字母、数字、点、下划线、冒号和连字符；非法值会被 UUID 替换。

HTTP 日志不记录 Authorization、body、query 或消息正文。生产部署仍需在边界层配置 TLS、连接数和超时。
