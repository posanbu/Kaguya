# OpenAI-compatible LLM 通用接口

`@kaguya/llm/openai-compatible` 导出 `OpenAiCompatibleLlmService`，供 core/application 层按次配置 API 地址、鉴权方式和模型，并通过 OpenAI-compatible `chat/completions` 协议生成文本。它是内部 TypeScript adapter，不是应用 API 网关的 HTTP 接口。包根路径继续兼容导出该 API，但新代码应使用独立子路径。

该接口适合核心层 provider 集成、独立连通性测试和受信任的服务端工具。它与工作流使用的 `KaguyaLlmClient` 是两个不同边界：当前不会写入 `llm_traces`，也不会自动执行 route/reply/state/memory 的 JSON schema 校验。

## SDK 选型与职责

按照 [Issue #1](https://github.com/posanbu/Kaguya/issues/1)，通用接口已从手写 `fetch` 迁移到 Vercel AI SDK，固定使用 `ai@7.0.35` 和 `@ai-sdk/openai-compatible@3.0.14`：

- `createOpenAICompatible` 根据每次调用的 base URL、API key、鉴权 header 和额外 headers 创建 provider；
- `generateText` 负责组装 provider 请求、解析文本与 usage、执行 `maxRetries` 指定的重试，并处理整次生成的超时和取消信号；
- `OpenAiCompatibleLlmService` 保留输入校验、动态 provider 配置、统一结果、错误分类和结构化日志的稳定应用边界。

没有引入 xsAI。仓库的正式工作流已经使用 Vercel AI SDK，继续使用同一套模型抽象可以共享类型、错误语义和测试工具，避免同时维护两套 provider 调用层。

SDK 只负责模型协议与调用生命周期，不负责 HTTP 网关、消息分发或 workflow 选择。provider allowlist、HTTPS 要求、密钥来源、成本限制和日志脱敏应由未来的 core/application adapter 负责。`apps/api` 不导入或暴露这个 service，也不接收 API key、base URL 或模型参数。

## 基本用法

只应在受信任的 core/application composition root 中调用该接口。provider 配置应来自服务端配置或密钥存储，不能从 `POST /api/v1/messages` 透传，也不能把平台密钥打包到浏览器代码中。

```ts
import {
  OpenAiCompatibleLlmService,
  createPinoLlmLogger,
} from "@kaguya/llm/openai-compatible";
import {
  closeLogger,
  createLogger,
  createModuleLogger,
  readLoggerOptions,
} from "@kaguya/logger";

const rootLogger = createLogger(readLoggerOptions("kaguya-core"));
const logger = createModuleLogger(rootLogger, "llm:openai-compatible");

const service = new OpenAiCompatibleLlmService({
  logger: createPinoLlmLogger(logger),
});

const providerConfig = {
  apiKey: process.env.PROVIDER_API_KEY ?? "",
  baseUrl: process.env.PROVIDER_BASE_URL,
  model: process.env.PROVIDER_MODEL ?? "gpt-5",
};

const result = await service.call({
  ...providerConfig,
  systemPrompt: "Answer concisely.",
  userPrompt: "Hello",
  temperature: 0,
  maxRetries: 2,
  timeoutMs: 30_000,
});

console.log(result.content);
console.log(result.usage);
await closeLogger(rootLogger);
```

`OpenAiCompatibleLlmService` 默认不输出日志。生产 composition root 应通过 `createPinoLlmLogger()` 接入 `@kaguya/logger`，从当前 AsyncLocalStorage 上下文继承 `traceId/sessionId/workflowId/nodeId` 等关联字段。`createConsoleLlmLogger()` 仅为兼容已有本地工具保留，不提供命名空间、上下文传播或统一脱敏策略。

## 请求字段

| 字段                | 必填 | 默认值                      | 说明                                                                                      |
| ------------------- | ---- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `apiKey`            | 是   | 无                          | API 密钥，只用于本次请求                                                                  |
| `baseUrl`           | 否   | `https://api.openai.com/v1` | API base URL，或完整的 `chat/completions` URL                                             |
| `model`             | 是   | 无                          | 本次调用使用的模型 ID                                                                     |
| `systemPrompt`      | 是   | 无                          | system 消息；只用 trim 结果校验非空，发送时保留原始空白                                   |
| `userPrompt`        | 是   | 无                          | user 消息；只用 trim 结果校验非空，发送时保留原始空白                                     |
| `temperature`       | 否   | `0`                         | 取值范围 `0..2`                                                                           |
| `maxRetries`        | 否   | `2`                         | 直接交给 `generateText` 的最大重试次数，取值范围 `0..10`                                  |
| `timeoutMs`         | 否   | `30000`                     | 整次 SDK 调用的总超时，取值范围 `1..300000`                                               |
| `apiKeyHeader`      | 否   | `Authorization`             | 非 Bearer 服务可设置为 `api-key` 等 header 名称；不能使用 `Content-Type` 或保留 header    |
| `additionalHeaders` | 否   | 无                          | provider 要求的额外 HTTP headers；不能覆盖 `Content-Type` 或连接/请求 framing 保留 header |
| `signal`            | 否   | 无                          | 调用方提供的 `AbortSignal`，用于取消整个调用                                              |

当 `apiKeyHeader` 为 `Authorization` 时，密钥通过 provider SDK 的 `apiKey` 选项传入，由 SDK 生成 `Bearer <apiKey>`；使用其他 header 名称时通过 SDK 的自定义 headers 发送密钥值。

## URL 规则

- `https://gateway.example/v1` 会转换为 `https://gateway.example/v1/chat/completions`。
- 已以 `/chat/completions` 结尾的完整地址保持不变。
- URL query 会按原始形式保留，包括重复参数、顺序和百分号编码，可用于 Azure `api-version` 或签名地址。
- 仅允许 `http` 和 `https` 协议。
- adapter 注入 provider 的 fetch wrapper 会强制使用 `redirect: "error"`，不会自动跟随 provider 重定向；这是 Kaguya 的传输策略，不是 SDK 默认行为。
- 通用 service 本身允许调用任意 HTTP(S) host；HTTPS 默认策略和 hostname allowlist 由调用它的 core/application adapter 提供。

Azure 风格示例：

```ts
await service.call({
  apiKey,
  apiKeyHeader: "api-key",
  baseUrl:
    "https://example.openai.azure.com/openai/deployments/my-model/chat/completions?api-version=2026-01-01",
  model: "my-model",
  systemPrompt: "Answer concisely.",
  userPrompt: "Hello",
});
```

## 返回结果

```ts
interface OpenAiCompatibleResult {
  content: string;
  model: string;
  requestId?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  attempts: number;
  durationMs: number;
}
```

`model` 优先使用 provider 响应中的模型 ID；provider 未返回时使用请求值。`usage` 和 `requestId` 取决于 provider 是否返回相应数据；如果 provider 只返回原始 `usage.total_tokens`，service 也会保留该总数。

## 重试与错误

`maxRetries` 直接传给 `generateText`。哪些 provider、限流或网络错误可以重试，以及退避和 `Retry-After` 的处理，由 Vercel AI SDK 统一实现；Kaguya 不再维护第二套 HTTP 重试循环。

本次迁移删除了 `retryDelayMs` 请求字段，因为 AI SDK v7 不公开可配置的初始退避时间。继续接受该字段会让调用方误以为它能够影响 SDK，属于虚假配置，因此这是一次明确的 API 契约调整。

`timeoutMs` 的语义也从“每次 HTTP 尝试的超时”调整为“整次 `generateText` 调用的总超时”。调用方传入的 `signal` 会直接作为 SDK 的 `abortSignal`，可以取消当前请求和后续重试。未来的核心 adapter 可以把自身的任务取消信号传入这里。无论由调用方中止还是由 SDK 总超时触发，公开错误都会归类为 `cancelled`。

配置错误不会进入 SDK；SDK 调用失败后由 service 统一归一化为 `OpenAiCompatibleError`：

| `kind`          | 含义                                        |
| --------------- | ------------------------------------------- |
| `configuration` | 请求字段或 URL 配置非法，请在发送前修正     |
| `retryable`     | SDK 标记为可重试的 provider、限流或网络错误 |
| `non-retryable` | 鉴权、请求、协议或响应内容错误              |
| `cancelled`     | 调用方 `AbortSignal` 中止或 SDK 总超时      |

错误还包含 `attempts`，provider 错误可能包含 `status`。归一化错误使用稳定的脱敏 `message`，也不会保留 SDK 原始异常的 `cause`，因为原始异常中可能包含完整 Prompt、请求头、provider 错误消息或响应体；接口在 SDK 用尽 `maxRetries` 后抛出归一化后的错误。

## 日志与安全边界

结构化日志只记录事件名、模型、endpoint、尝试次数、耗时、状态、usage 和错误分类，不记录 provider 原始错误消息、API key、Prompt 或模型回答。日志中的 `endpoint` 仅保留 provider 的 URL origin，不保留可能包含租户标识、部署路径、签名参数或其他敏感信息的 path、query 和 hash。`apiKeyHeader` 与 `additionalHeaders` 会拒绝 `Host`、`Content-Length`、`Transfer-Encoding`、`Connection`、`Proxy-Authorization` 等连接或请求 framing 保留 header。adapter 的 fetch wrapper 强制使用 `redirect: "error"`，调用方必须提供最终 provider 地址。

`@kaguya/logger` 还会默认遮盖常见凭证和内容字段，并把 Error 收敛为分类元数据；这只是额外兜底，不能替代 service 自身“不构造敏感日志事件”的边界。统一日志配置、命名空间级别和同步/异步输出约定见 [结构化日志](logging.md)。

生产接入还必须在 core/application 层完成以下控制：

- 不把 API key 写入数据库、普通日志、错误响应或浏览器持久存储；
- 只从受信任配置读取 provider，并对允许的 host 建立 allowlist，避免任意 URL 造成 SSRF；
- 对 `additionalHeaders` 和完整 URL 做权限控制；
- 限制请求大小、用户调用频率、模型范围和成本预算；
- 根据数据合规要求决定 Prompt 是否允许发送给第三方 provider；
- 如果调用属于正式工作流，应通过 adapter 接入 `KaguyaLlmClient`，保留 schema 校验与 `llm_traces`。

## 当前限制

- 仅实现 OpenAI-compatible chat completions 文本响应；
- 暂不支持流式输出、tools/function calling、多模态输入和 embedding；
- 不负责保存模型配置、密钥或调用历史；
- 仓库当前没有 Web UI；本接口是内部 TypeScript adapter，不由 `apps/api` 暴露；
- demo 仍使用确定性 mock model，不会访问远端 API。
