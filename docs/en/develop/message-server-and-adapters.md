# HTTP API 与统一 Server

`apps/server` 是 Kaguya 唯一服务入口。它在一个 Fastify 实例上提供 Web UI、健康检查、OpenAPI 和消息 API，并把消息直接交给同进程的 `KaguyaRuntime`。旧 `apps/api`、`apps/bot` 及其启动命令不再存在。

## 启动

```bash
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm dev
```

开发时 UI、HMR 与 API 共用 `http://127.0.0.1:3000`。生产运行：

```bash
pnpm build
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm start
```

## Server 配置

| 环境变量                             | 默认值                | 约束/用途                                    |
| ------------------------------------ | --------------------- | -------------------------------------------- |
| `KAGUYA_GATEWAY_TOKEN`               | 无                    | 必填，至少 16 字符；消息 API Bearer Token    |
| `KAGUYA_HOST`                        | `127.0.0.1`           | 唯一监听地址                                 |
| `KAGUYA_PORT`                        | `3000`                | `1..65535`                                   |
| `KAGUYA_DATABASE_PATH`               | `.data/kaguya.sqlite` | 唯一 Runtime 数据库                          |
| `KAGUYA_CONFIG_ROOT`                 | `.data/kaguya-config` | 权限保护的 profile registry                  |
| `KAGUYA_CORS_ORIGINS`                | 空                    | 逗号分隔；空值关闭跨源许可，同源 UI 不受影响 |
| `KAGUYA_TRUST_PROXY`                 | 空                    | 逗号分隔的可信代理地址/CIDR                  |
| `KAGUYA_RATE_LIMIT_MAX`              | `30`                  | `1..10000`                                   |
| `KAGUYA_RATE_LIMIT_WINDOW_MS`        | `60000`               | `1000..3600000` 毫秒                         |
| `KAGUYA_WEB_DIST_PATH`               | `apps/web/dist`       | 生产静态产物目录，主要用于测试/部署覆盖      |
| `KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS` | 空                    | 逗号分隔的平台 ID；空值表示不限制            |
| `KAGUYA_GATEWAY_ALLOWLIST_USER_IDS`  | 空                    | 逗号分隔的用户 ID；空值表示不限制            |
| `KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS` | 空                    | 逗号分隔的群组 ID；空值表示不限制            |

NapCat 配置：

| 环境变量                     | 默认值  | 约束/用途                          |
| ---------------------------- | ------- | ---------------------------------- |
| `KAGUYA_NAPCAT_ENABLED`      | `false` | `true` 时启动 WebSocket supervisor |
| `KAGUYA_NAPCAT_WS_URL`       | 无      | NapCat 启用时必填                  |
| `KAGUYA_NAPCAT_ACCESS_TOKEN` | 无      | 作为连接凭据使用，禁止写日志       |
| `KAGUYA_NAPCAT_SELF_ID`      | 无      | 可选，校验收到事件的机器人 ID      |
| `KAGUYA_NAPCAT_RECONNECT_MS` | `3000`  | `100..3600000` 毫秒                |

检测到 `KAGUYA_API_HOST`、`KAGUYA_API_PORT`、`KAGUYA_API_DATABASE_PATH`、`KAGUYA_BOT_DATABASE_PATH` 或旧 `KAGUYA_LLM_*` 变量时启动失败。Provider、key 和 light/heavy target 只从 profile store 加载。

日志配置见 [结构化日志](logging.md)。

## 统一配置引导

`KAGUYA_CONFIG_ROOT` 尚未初始化、当前 `selectedProfileId` 对应的 Profile 不完整，或者可选配置尚未确认时，Server 都会进入统一的配置模式。此时 HTTP 和 Web UI 继续启动，但 Runtime 消息处理和 NapCat 入站不会启动。浏览器访问服务根路径会显示同一个 Profile 管理页面，而不是单独的“首次配置写接口”。

配置页面先通过 `GET /api/v1/setup` 读取 `setup_required`、`invalid`、`review_required`、`restart_required` 或 `ready` 状态。该接口只返回 secret-safe metadata、`selectedProfileId`、issues 和 warnings，不返回完整 Profile 或密钥。

真正的配置修改通过显式 Profile 管理接口完成：

- `GET /api/v1/profiles`
- `POST /api/v1/profiles`
- `GET /api/v1/profiles/:profileId`
- `PUT /api/v1/profiles/:profileId`
- `PUT /api/v1/profiles/selection`
- `DELETE /api/v1/profiles/:profileId`

全新配置根会先通过 bootstrap 创建保留的空 `default` Profile，并把 `selectedProfileId` 设为 `"default"`。之后，用户可以配置 `default`，或者先创建并命名新的 Profile，再显式选择它。如果保存或切换后，当前 selected Profile 仍然是 `invalid` 或 `review_required`，页面会继续停留在 readiness 引导状态，而不会提示重启。选择某个 Profile，或完整替换当前 selected Profile，都会锁存一次重启要求；只有当该 selected Profile 已经 ready 时，页面才会进入 `restart_required`。只有重启 Server，Runtime 才会在新的启动周期里重新加载全局 Profile、模型客户端和平台连接。

配置文件损坏、路径越界、符号链接或权限错误不属于可自动修复的“缺失配置”，Server 会拒绝启动并保留原文件，避免引导流程覆盖需要人工恢复的数据。`KAGUYA_GATEWAY_TOKEN` 仍是启动 HTTP 前必须提供的安全凭据；匿名 setup 模式不能读取完整 Profile，也不能写入配置。

## 平台入站白名单

白名单位于 Runtime 的入站边界，而不是普通回复模块内部。这样，被拒绝的消息不会写入消息表，也不会发布 `message.ingested` 事件，因此不会触发 Prompt、LLM 或出站 transport。Web UI 消息不携带平台身份，始终沿用原有网关行为。

三个变量分别限制平台、发送用户和目标群组。只要某个变量配置了值，对应字段就必须命中；多个变量同时配置时采用“同时满足”的关系。未配置的维度是通配条件。例如，只设置 `KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS=123,456` 时，只有这两个群组中的群消息会进入机器人流程，私聊会被过滤；只设置用户 ID 时，匹配用户的私聊和群消息都可以进入。

ID 会在读取配置时按逗号拆分、去除首尾空白并去重。过滤结果会以 `message.dispatch.filtered` 写入结构化日志，日志只记录平台、adapter 和目标类型，不记录消息正文或凭据。

## 路由

| 方法和路径                 | 认证         | 用途                       |
| -------------------------- | ------------ | -------------------------- |
| `GET /` 和静态资源         | 无           | Web UI                     |
| `GET /healthz`             | 无           | 服务存活检查               |
| `GET /api/v1/openapi.json` | 无           | OpenAPI 文档               |
| `POST /api/v1/messages`    | Bearer Token | Web 消息落库并发布模块事件 |

生产 SPA fallback 只接受带 `text/html` 的 GET 页面请求，且显式排除 `/api/*` 和 `/healthz`。未知 API 仍返回结构化 `404 not_found`。

## 提交消息

请求体只允许两个字段：

```json
{
  "sessionId": "session-1",
  "text": "Hello"
}
```

- `sessionId` trim 后非空，最多 256 个 Unicode code point；它只是兼容协议中的 opaque Web source ID，不创建 Core session、历史或 profile binding；
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

接口不返回模型回答，不提供查询或 SSE。Web 输入会写入用户消息并进入默认 filter/LLM 模块；默认模块没有 Web destination，因此不会发出 outbound request。自定义模块如需发送，必须自行配置已注册 adapter 和 destination。

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
- 请求不能指定 provider、API key、base URL、模型、模块或 transport destination；
- HTTP 日志不记录 Authorization、body、query 或消息正文；
- `KAGUYA_TRUST_PROXY` 为空时不信任转发地址；
- 生产部署仍需在边界层配置 TLS、连接数和超时。

## NapCat 可用性

NapCat supervisor 将 OneBot 消息标准化后以 `kind: "platform"` dispatch 到同一个 Runtime，并在 ingress 启动前以稳定 `adapterId` 注册为 outbound transport。模块提供的 destination 与 `text`/`reply` 消息会原样交给该 transport；Core 不从入站消息推导目标。断线期间发送产生可审计的失败，supervisor 按配置重连。连接失败不会停止 Fastify，也不会改变 `/healthz`。
