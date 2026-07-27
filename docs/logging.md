# 结构化日志

`@kaguya/logger` 是 Kaguya 的统一日志基础包。它基于 Pino 10，提供单行 JSON、模块命名空间、AsyncLocalStorage 链路上下文、敏感字段脱敏和可选 worker transport。实现对应 [Issue #5](https://github.com/posanbu/Kaguya/issues/5)。

## 基本用法

应用 composition root 创建一次根 Logger，各模块只创建 child Logger，不创建全局单例：

```ts
import {
  closeLogger,
  createLogger,
  createModuleLogger,
  readLoggerOptions,
  runWithLogContext,
} from "@kaguya/logger";

const rootLogger = createLogger(readLoggerOptions("kaguya-core"));
const workflowLogger = createModuleLogger(rootLogger, "engine:workflow");

await runWithLogContext(
  {
    traceId: "trace-1",
    sessionId: "session-1",
    workflowId: "message-workflow",
  },
  async () => {
    workflowLogger.info({ event: "workflow.started" }, "Workflow started");
  },
);

await closeLogger(rootLogger);
```

`runWithLogContext` 会合并当前上下文并在同步调用、Promise、timer 和同一异步资源链中传播。并发链路使用相互隔离的 store。允许的关联字段只有：

| 字段         | 用途                                              |
| ------------ | ------------------------------------------------- |
| `traceId`    | 顶层消息、心跳或调度及其所有派生工作的共同链路 ID |
| `sessionId`  | 会话关联                                          |
| `eventId`    | 具体事件                                          |
| `runId`      | 持久化运行或任务                                  |
| `requestId`  | HTTP 请求                                         |
| `workflowId` | 工作流                                            |
| `nodeId`     | 工作流节点                                        |

上下文值必须是 1 到 512 个字符，未知字段会被拒绝。业务字段应放在单次日志对象中，不应塞入长期上下文。

## 日志约定

- `service` 标识进程或部署单元，例如 `kaguya-api`；
- `module` 使用冒号分隔的命名空间，例如 `engine:workflow:message`；
- `event` 使用稳定的小写点分事件名，例如 `gateway.message.accepted`；
- `msg` 只写便于人工阅读的稳定描述，不拼接用户输入或凭证；
- 耗时统一使用 `durationMs`，计数保持数字类型；
- 关联 ID 由上下文注入，不在每条日志中重复手工拼装。

输出使用 ISO 8601 `time` 和字符串 `level`。Pino 保证同一 destination 内的写入顺序，但多个进程或多个 destination 不存在全局总序；聚合系统应结合 `time` 和关联 ID 排序。

## 环境变量

`readLoggerOptions(service)` 读取以下配置：

| 环境变量                 | 默认值   | 说明                                                                |
| ------------------------ | -------- | ------------------------------------------------------------------- |
| `KAGUYA_LOG_LEVEL`       | `info`   | `trace/debug/info/warn/error/fatal/silent`                          |
| `KAGUYA_LOG_LEVELS`      | 空       | 逗号分隔的 `namespace=level`；最长命名空间前缀优先                  |
| `KAGUYA_LOG_ASYNC`       | `false`  | `true/1` 使用 Pino worker transport；`false/0` 使用同步 destination |
| `KAGUYA_LOG_DESTINATION` | `stdout` | `stdout`、`stderr` 或文件路径；文件目录不存在时由 Pino 创建         |

示例：

```powershell
$env:KAGUYA_LOG_LEVEL = "info"
$env:KAGUYA_LOG_LEVELS = "engine:workflow=debug,adapter:napcat=warn"
$env:KAGUYA_LOG_ASYNC = "true"
$env:KAGUYA_LOG_DESTINATION = ".data/logs/kaguya.jsonl"
```

默认同步输出用于保持开发、测试和关键启动日志的确定顺序。高吞吐生产进程可显式启用 worker transport，把写入移出主线程。正常关闭时必须调用 `closeLogger(rootLogger)`；强制终止或进程崩溃仍可能丢失尚未刷新的异步日志。

## 安全边界

默认 redaction 会遮盖常见 API key、token、authorization、password、secret、Prompt、消息正文和 body 字段。`err`/`error` 只保留 `type`、`code`、`statusCode` 和 `retryable`，不会自动记录原始 `message`、`stack` 或 `cause`。HTTP request serializer 不记录 headers、body 或 query，只保留 request ID、method、无 query 的 path 和远端地址。

这些机制只是误用兜底，不代表可以主动记录敏感内容：

- 不记录 API key、Bearer Token、平台凭证或完整配置；
- 不记录 Prompt、模型回答、用户消息正文或 provider 原始响应；
- 不把任意原始 Error、HTTP headers/body 或完整 URL 展开到其他字段；
- 新增敏感字段时同时更新日志调用、redaction 测试和数据访问策略；
- 需要保存 Prompt 或模型输出时使用受控的 trace repository，不使用普通运行日志。

## 当前接入

- `apps/api` 使用 Pino 实例作为 Fastify logger，并把 `requestId` 注入整个请求链；合法消息进入 core ingress 时再加入 `sessionId`。网关只记录 `gateway.message.accepted` 等元数据，不记录消息正文或 Authorization header。
- `@kaguya/llm` 提供 `createPinoLlmLogger()`，把现有 `llm.call.started/succeeded/failed` 事件写入模块 Logger；事件仍只包含模型、provider origin、尝试次数、耗时、usage 和错误分类。

事件总线、工作流、scheduler、database 和平台 adapter 尚未全部接入统一 Logger。跨进程 trace、指标、告警、日志采集、保留周期和访问控制仍属于生产可观测性后续工作。

## 验证

```powershell
pnpm exec vitest run packages/logger/src/index.test.ts
pnpm typecheck
pnpm build
```

单元测试覆盖结构化字段、并发上下文隔离、嵌套上下文、命名空间级别、敏感信息脱敏、安全错误/HTTP 序列化、环境变量校验，以及 worker transport 的写入顺序和关闭刷新。
