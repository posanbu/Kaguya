# 结构化日志

Kaguya 只有一个根 Logger，`service` 固定为 `kaguya`。`apps/server` 创建并最终关闭它；Server、Runtime、EventBus observer、workflow recorder 和 NapCat 都使用 child Logger，不创建第二套日志出口。

## 输出格式

| 环境                   | 默认格式 | 默认目标    |
| ---------------------- | -------- | ----------- |
| `NODE_ENV=development` | `pretty` | 同步 stdout |
| 其他/production        | `json`   | 同步 stdout |

`KAGUYA_LOG_FORMAT=pretty|json` 可显式覆盖。pretty 只允许同步 stdout/stderr；pretty 与 `KAGUYA_LOG_ASYNC=true` 或文件 destination 组合会在启动时直接报配置错误。JSON 继续支持同步/异步和文件输出。

| 环境变量                 | 默认值        | 说明                                       |
| ------------------------ | ------------- | ------------------------------------------ |
| `KAGUYA_LOG_FORMAT`      | 按 `NODE_ENV` | `pretty` 或 `json`                         |
| `KAGUYA_LOG_LEVEL`       | `info`        | `trace/debug/info/warn/error/fatal/silent` |
| `KAGUYA_LOG_LEVELS`      | 空            | 逗号分隔 `namespace=level`，最长前缀优先   |
| `KAGUYA_LOG_ASYNC`       | `false`       | 仅 JSON；`true/1` 启用 worker transport    |
| `KAGUYA_LOG_DESTINATION` | `stdout`      | `stdout`、`stderr`；JSON 还可使用文件路径  |

开发调试事件和节点：

```bash
KAGUYA_LOG_LEVEL=info \
KAGUYA_LOG_LEVELS="runtime:event=debug,runtime:workflow=debug" \
KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters" \
pnpm dev
```

生产 JSON 文件示例：

```bash
NODE_ENV=production \
KAGUYA_LOG_FORMAT=json \
KAGUYA_LOG_ASYNC=true \
KAGUYA_LOG_DESTINATION=.data/logs/kaguya.jsonl \
KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters" \
pnpm start
```

正常关闭最终调用 `closeLogger()`，先 flush 再关闭 destination。强制终止仍可能丢失尚未刷新的异步日志。

## 模块

| module             | 范围                                     |
| ------------------ | ---------------------------------------- |
| `server`           | 进程启动、监听和关闭                     |
| `server:http`      | HTTP 接受与请求失败                      |
| `runtime`          | Runtime、模块 dispatch 和 transport 结果 |
| `runtime:event`    | EventBus observer                        |
| `runtime:workflow` | 显式 heartbeat/memory workflow 生命周期  |
| `adapter:napcat`   | NapCat 连接、重连、入站和投递            |
| `llm`              | LLM/provider 边界日志                    |

命名空间覆盖使用最长前缀，因此 `runtime:workflow=debug` 不会开启其他 Runtime debug 日志。

## 关联上下文

AsyncLocalStorage 传播下列字段，并隔离并发请求：

| 字段                            | 来源                      |
| ------------------------------- | ------------------------- |
| `requestId`                     | Fastify 请求 hook         |
| `traceId`                       | 每次 Runtime dispatch     |
| `eventId`                       | EventBus observer         |
| `runId`、`workflowId`、`nodeId` | workflow recorder wrapper |

上下文值必须为 1–512 个字符；未知字段会被拒绝。Web trace 使用 `webui-${requestId}`，平台 trace 由 adapter 提供。

## 日志事件表

`info` 只用于服务/Runtime 生命周期、HTTP 消息接受、dispatch 完成以及 NapCat 连接/投递状态。详细执行步骤使用 `debug`，失败使用 `warn`、`error` 或 `fatal`。

| event                                              | 级别  | module             | 含义                                     |
| -------------------------------------------------- | ----- | ------------------ | ---------------------------------------- |
| `server.starting` / `server.started`               | info  | `server`           | 唯一 Server 启动                         |
| `server.stopping` / `server.stopped`               | info  | `server`           | 有序关闭                                 |
| `server.start.failed` / `server.shutdown.failed`   | fatal | `server`           | 启动或关闭失败                           |
| `runtime.started` / `runtime.stopped`              | info  | `runtime`          | SQLite 与共享组件生命周期                |
| `message.dispatch.started`                         | debug | `runtime`          | 一条消息开始进入模块链                   |
| `message.dispatch.completed`                       | info  | `runtime`          | 模块 dispatch 结果与 outbound 状态       |
| `message.dispatch.failed`                          | error | `runtime`          | dispatch 失败                            |
| `http.message.accepted`                            | info  | `server:http`      | HTTP 消息已由 Runtime 完成处理并返回 202 |
| `http.request.failed`                              | error | `server:http`      | 未处理 HTTP 错误                         |
| `event.emitted`                                    | debug | `runtime:event`    | EventBus observer 看见已发布事件         |
| `event.observer.failed`                            | error | `runtime:event`    | observer 自身失败，不改变业务结果        |
| `workflow.node.started/completed/failed/cancelled` | debug | `runtime:workflow` | recorder 已持久化节点状态                |
| `napcat.connection.starting/connected`             | info  | `adapter:napcat`   | 平台连接状态                             |
| `napcat.connection.disconnected/failed`            | warn  | `adapter:napcat`   | 断线或连接失败                           |
| `napcat.reconnect.scheduled`                       | info  | `adapter:napcat`   | 已安排重连                               |
| `napcat.inbound.failed`                            | error | `adapter:napcat`   | 标准化消息 dispatch 失败                 |
| `platform.delivery.completed`                      | info  | `runtime`          | 通用 outbound transport 成功             |
| `platform.delivery.failed`                         | warn  | `runtime`          | 通用 outbound transport 失败             |
| `llm.call.started`                                 | info  | `llm`              | LLM 请求开始，包含受控 `input` 摘要      |
| `llm.call.succeeded`                               | info  | `llm`              | LLM 请求成功，包含耗时、尝试次数和 usage |
| `llm.call.failed`                                  | error | `llm`              | LLM 请求失败，包含安全错误分类           |

Fastify 的通用每请求 info 日志已关闭，避免健康检查和静态资源淹没业务日志。

`llm.call.started.input` 使用 `openai-compatible.chat` 格式，记录：

- `modality`：`text` 或 `multimodal`，用于快速判断是否走了多模态输入；
- `messages[]`：每条输入的 `role`、`contentTypes`、`charCount` 和短 `preview`；
- `temperature`、`maxRetries`、`timeoutMs`。

`preview` 只保留前若干字符，用于排查路由、Prompt 组装和输入形态；完整 Prompt 仍以受控 SQLite LLM trace 为准。

## 脱敏边界

普通日志禁止包含：

- 用户消息全文、Prompt 全文、模型输出；
- 平台 raw payload、target ID；
- Bearer/API/access token、credentials、password、secret；
- NapCat WebSocket URL；
- 完整配置、HTTP headers/body/query 或 provider 原始响应。

唯一例外是 `llm.call.started.input.messages[].preview`，它只保留输入前若干字符，并搭配 `contentTypes`、`charCount` 和 `modality` 判断本次请求形态。不要把 provider 错误、HTTP body、模型输出或完整 Prompt 当作普通日志字段写出。

默认 redaction 覆盖常见 `apiKey`、`api_key`、`token`、`accessToken`、`access_token`、`authorization`、`credentials`、`raw`、`wsUrl`、Prompt/content/text/body 等路径。Error serializer 只保留 `type`、`code`、`statusCode`、`retryable` 以及安全的 LLM 分类；嵌套 `AggregateError` 只增加叶子失败数量和一致分类，不展开 children/cause。request serializer 只保留 request ID、method、无 query path 和远端地址。

redaction 是误用兜底，不是记录敏感数据的授权。Prompt 和模型输出需要审计时只使用受控 SQLite trace repository。

## 排障

- 启动时报 “pretty logging cannot be asynchronous”：改用 `KAGUYA_LOG_FORMAT=json`，或关闭 `KAGUYA_LOG_ASYNC`；
- 启动时报 “pretty logging only supports stdout or stderr”：移除文件 destination，或改用 JSON；
- 看不到 event/node：将 `runtime:event`、`runtime:workflow` 提升到 `debug`；
- Web 可用但平台断线：筛选 `module=adapter:napcat`，观察 connected/disconnected/failed/reconnect；
- HTTP 500：用 response 的 request ID 筛选 `requestId`，再沿 `traceId` 查看 Runtime；
- 节点失败：以 `traceId + runId + workflowId + nodeId` 关联 `workflow.node.failed` 和数据库 `event_runs`；
- 关闭日志缺失：确认进程收到 SIGINT/SIGTERM 并完成优雅关闭，而非被强制终止。
