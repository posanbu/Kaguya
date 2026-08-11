# HTTP API 与统一 Server

`apps/server` 是 Kaguya 唯一服务入口。它在一个 Fastify 实例上提供 Web UI、健康检查、OpenAPI 和消息 API，并把消息直接交给同进程的 `KaguyaRuntime`。旧 `apps/api`、`apps/bot` 及其启动命令不再存在。

## 启动

```bash
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
pnpm dev
```

开发时 UI、HMR 与 API 共用 `http://127.0.0.1:3000`。生产运行：

```bash
pnpm build
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
pnpm start
```

## Server 配置

| 环境变量                      | 默认值                | 约束/用途                                    |
| ----------------------------- | --------------------- | -------------------------------------------- |
| `KAGUYA_GATEWAY_TOKEN`        | 无                    | 必填，至少 16 字符；消息 API Bearer Token    |
| `KAGUYA_HOST`                 | `127.0.0.1`           | 唯一监听地址                                 |
| `KAGUYA_PORT`                 | `3000`                | `1..65535`                                   |
| `KAGUYA_DATABASE_PATH`        | `.data/kaguya.sqlite` | 唯一 Runtime 数据库                          |
| `KAGUYA_CORS_ORIGINS`         | 空                    | 逗号分隔；空值关闭跨源许可，同源 UI 不受影响 |
| `KAGUYA_TRUST_PROXY`          | 空                    | 逗号分隔的可信代理地址/CIDR                  |
| `KAGUYA_RATE_LIMIT_MAX`       | `30`                  | `1..10000`                                   |
| `KAGUYA_RATE_LIMIT_WINDOW_MS` | `60000`               | `1000..3600000` 毫秒                         |
| `KAGUYA_WEB_DIST_PATH`        | `apps/web/dist`       | 生产静态产物目录，主要用于测试/部署覆盖      |

NapCat 配置：

| 环境变量                     | 默认值  | 约束/用途                          |
| ---------------------------- | ------- | ---------------------------------- |
| `KAGUYA_NAPCAT_ENABLED`      | `false` | `true` 时启动 WebSocket supervisor |
| `KAGUYA_NAPCAT_WS_URL`       | 无      | NapCat 启用时必填                  |
| `KAGUYA_NAPCAT_ACCESS_TOKEN` | 无      | 作为连接凭据使用，禁止写日志       |
| `KAGUYA_NAPCAT_SELF_ID`      | 无      | 可选，校验收到事件的机器人 ID      |
| `KAGUYA_NAPCAT_RECONNECT_MS` | `3000`  | `100..3600000` 毫秒                |

检测到 `KAGUYA_API_HOST`、`KAGUYA_API_PORT`、`KAGUYA_API_DATABASE_PATH` 或 `KAGUYA_BOT_DATABASE_PATH` 时启动失败。不存在旧配置兼容层。

日志配置见 [结构化日志](logging.md)。

## 路由

| 方法和路径                 | 认证         | 用途                          |
| -------------------------- | ------------ | ----------------------------- |
| `GET /` 和静态资源         | 无           | Web UI                        |
| `GET /healthz`             | 无           | 服务存活检查                  |
| `GET /api/v1/openapi.json` | 无           | OpenAPI 文档                  |
| `POST /api/v1/messages`    | Bearer Token | Web 消息进入 message workflow |

生产 SPA fallback 只接受带 `text/html` 的 GET 页面请求，且显式排除 `/api/*` 和 `/healthz`。未知 API 仍返回结构化 `404 not_found`。

## 提交消息

请求体只允许两个字段：

```json
{
  "sessionId": "session-1",
  "text": "Hello"
}
```

- `sessionId` trim 后非空，最多 256 个 Unicode code point；
- `text` trim 后必须非空，最多 131072 个 Unicode code point，工作流保留原始空白；
- 请求体最多 256 KiB；
- 任何额外字段都会被严格 schema 拒绝。

```bash
curl http://127.0.0.1:3000/api/v1/messages \
  -H "Authorization: Bearer replace-with-at-least-16-characters" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: example-1" \
  -d '{"sessionId":"session-1","text":"Hello"}'
```

Runtime dispatch 成功后保持现有 `202` 协议：

```json
{
  "data": {
    "status": "accepted",
    "requestId": "example-1"
  }
}
```

接口不返回模型回答，不提供查询或 SSE。Web 输入会写入用户/助手消息与 trace，但因为没有平台 sender，不触发任何平台投递。

失败统一返回：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Request validation failed",
    "requestId": "example-1"
  }
}
```

| 错误码             | 常见状态   | 含义                                     |
| ------------------ | ---------- | ---------------------------------------- |
| `unauthorized`     | 401        | Bearer Token 缺失或错误                  |
| `invalid_request`  | 400        | JSON 或 schema 不合法                    |
| `not_found`        | 404        | 路由不存在                               |
| `rate_limited`     | 429        | 超过来源限流                             |
| `request_rejected` | 413/415 等 | Fastify 在进入 Runtime 前拒绝请求        |
| `core_unavailable` | 503        | 测试/嵌入场景没有配置 Runtime dispatcher |
| `internal_error`   | 500        | Runtime dispatch 或 Server 内部失败      |

## 请求 ID 与安全边界

合法 `X-Request-Id` 必须是 1–128 个 ASCII 字符：首字符为字母或数字，其余仅允许字母、数字、点、下划线、冒号和连字符；非法值被 UUID 替换。Web trace ID 固定为 `webui-${requestId}`。

- Bearer 认证先于业务校验；认证和未认证流量使用不同限流 key；
- 请求不能指定 provider、API key、base URL、模型或 workflow；
- HTTP 日志不记录 Authorization、body、query 或消息正文；
- `KAGUYA_TRUST_PROXY` 为空时不信任转发地址；
- 生产部署仍需在边界层配置 TLS、连接数和超时。

## NapCat 可用性

NapCat supervisor 将 OneBot 消息标准化后以 `kind: "platform"` dispatch 到同一个 Runtime，并将 supervisor 作为该消息的 `PlatformReplySender`。断线期间发送会返回失败 receipt；supervisor 按配置重连。连接失败不会停止 Fastify，也不会改变 `/healthz`。
