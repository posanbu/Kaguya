# 2026-07-25 应用 API 网关更新说明

本次更新为 Kaguya 增加第一阶段应用 API 网关，并强化 OpenAI-compatible LLM 调用边界。目标是让后续 Web UI 可以通过受控的服务端接口测试不同模型、API 地址和鉴权方式，同时避免浏览器直接访问模型供应商。

## 新增能力

- 新增 `@kaguya/api` Fastify 应用，提供统一的 HTTP composition root；
- 新增 `GET /healthz` 存活检查；
- 新增 `GET /api/v1/openapi.json` OpenAPI 文档；
- 新增 `POST /api/v1/llm/chat` 模型配置与连通性测试接口；
- 复用 `OpenAiCompatibleLlmService`，支持动态 API key、base URL、模型、Prompt、温度、超时与重试参数；
- 增加 Bearer 网关认证、CORS、按客户端 IP 限流、256 KiB 请求体上限和统一错误结构；
- 增加 provider hostname 白名单、HTTPS 默认策略、鉴权 header 白名单和 URL 凭证检查；
- `pnpm api:dev` 会先按 workspace 依赖顺序构建 `schema`、`llm` 和 `api`，避免使用缺失或陈旧的 `dist`。

## 测试发现与修复

新增的故障与安全测试发现并修复了以下问题：

| 问题                                 | 修复                                                              |
| ------------------------------------ | ----------------------------------------------------------------- |
| Bearer scheme 被按大小写匹配         | 按 HTTP 认证规范进行大小写无关匹配，并继续使用常量时间 token 比较 |
| body 校验早于认证                    | 将认证移动到 `onRequest`，未认证畸形请求统一返回 `401`            |
| 失败认证占用合法调用配额             | 按认证状态和客户端 IP 分离限流 key                                |
| Fastify 静默删除未知字段             | 关闭 AJV `removeAdditional`，未知字段返回 `invalid_request`       |
| 非 HTTP(S) URL 可通过网关层          | 在调用 LLM service 前拒绝不支持的协议                             |
| API key 与 Prompt 可经 HTTP 明文传输 | 默认只允许 HTTPS；本地 HTTP 必须由服务端显式开启                  |
| fetch 自动跟随 provider 重定向       | 设置 `redirect: "error"`，避免鉴权 header 离开批准的 endpoint     |
| API key 控制字符进入 HTTP header     | JSON Schema 与 Zod 两层拒绝控制字符                               |
| provider 错误可能回显到日志或 API    | 日志和网关响应只保留规范化的公开错误信息                          |
| 指数退避可能持续数小时               | 单次退避封顶 60 秒，并允许 `AbortSignal` 中断等待                 |
| 客户端断连后模型调用继续             | 将 socket 断连和模型调用总 deadline 连接到 LLM `AbortSignal`      |
| 反向代理后所有用户共享限流 IP        | 增加默认关闭的可信代理地址/CIDR 配置，拒绝未受信来源伪造转发 IP   |

## 新增配置

| 环境变量                         | 默认值           | 用途                              |
| -------------------------------- | ---------------- | --------------------------------- |
| `KAGUYA_GATEWAY_TOKEN`           | 无               | 网关 Bearer token，至少 16 个字符 |
| `KAGUYA_API_HOST`                | `127.0.0.1`      | HTTP 监听地址                     |
| `KAGUYA_API_PORT`                | `3000`           | HTTP 监听端口                     |
| `KAGUYA_CORS_ORIGINS`            | 本地 Vite 地址   | 允许的浏览器 origin 列表          |
| `KAGUYA_LLM_ALLOWED_HOSTS`       | `api.openai.com` | provider hostname 精确白名单      |
| `KAGUYA_LLM_ALLOW_INSECURE_HTTP` | `false`          | 显式允许 HTTP provider            |
| `KAGUYA_LLM_REQUEST_TIMEOUT_MS`  | `300000`         | 单次模型调用总 deadline           |
| `KAGUYA_TRUST_PROXY`             | 空               | 可信反向代理地址或 CIDR 列表      |
| `KAGUYA_RATE_LIMIT_MAX`          | `30`             | 每个限流窗口的最大请求数          |
| `KAGUYA_RATE_LIMIT_WINDOW_MS`    | `60000`          | 限流窗口毫秒数                    |

完整启动方式、请求示例和安全说明见 [应用 API 网关](../api-gateway.md)，底层模型调用约定见 [OpenAI-compatible LLM 通用接口](../openai-compatible-llm.md)。

## 兼容性变化

- 自定义 provider 使用 HTTP 时必须设置 `KAGUYA_LLM_ALLOW_INSECURE_HTTP=true`；生产环境应保持关闭。
- provider 的 HTTP 重定向不再自动跟随，调用方必须提供最终 API 地址。
- 请求中的未知字段不再被忽略，而是返回 `400 invalid_request`。
- API 不再返回 provider 原始错误消息；客户端应使用 `kind`、`providerStatus` 和 `requestId` 定位问题。
- `Retry-After` 和指数退避单次最多等待 60 秒，网关总 deadline 到期后会取消调用。

## 验证结果

- `pnpm build` 通过；
- `pnpm typecheck` 通过；
- `pnpm lint` 通过；
- `pnpm test` 通过，共 17 个测试文件、137 项测试；
- 实际 HTTP 冒烟验证覆盖健康检查、OpenAPI、认证顺序、协议拒绝和 header 控制字符校验。

## 当前边界

`POST /api/v1/llm/chat` 仍是模型配置测试接口，不是正式聊天工作流入口。它不会创建会话、调用 `dispatchEvent` 或写入 `event_runs`/`llm_traces`。持久 run、可重连 SSE、取消 API、有界队列、用户级授权和正式 Web UI 仍属于下一阶段。
