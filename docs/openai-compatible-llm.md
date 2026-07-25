# OpenAI-compatible LLM 通用接口

`@kaguya/llm` 导出 `OpenAiCompatibleLlmService`，用于从应用层或 UI 后端按次选择 API 地址、鉴权方式和模型，并通过 OpenAI-compatible `chat/completions` 协议生成文本。

该接口适合模型连通性测试、配置预览和独立文本生成。它与工作流使用的 `KaguyaLlmClient` 是两个不同边界：当前不会写入 `llm_traces`，也不会自动执行 route/reply/state/memory 的 JSON schema 校验。

## 基本用法

UI 应把表单提交到受信任的服务端路由，由服务端调用该接口。不要把平台统一密钥打包到浏览器代码中。

```ts
import {
  OpenAiCompatibleLlmService,
  createConsoleLlmLogger,
} from "@kaguya/llm";

const service = new OpenAiCompatibleLlmService({
  logger: createConsoleLlmLogger(),
});

const result = await service.call({
  apiKey: form.apiKey,
  baseUrl: form.baseUrl,
  model: form.model,
  systemPrompt: form.systemPrompt,
  userPrompt: form.userPrompt,
  temperature: 0,
  maxRetries: 2,
  timeoutMs: 30_000,
});

console.log(result.content);
console.log(result.usage);
```

`OpenAiCompatibleLlmService` 默认不输出日志。传入 `createConsoleLlmLogger()` 后，每条日志以单行 JSON 输出；生产应用也可以注入自己的 `OpenAiCompatibleLogger`，对接现有日志系统。

## 请求字段

| 字段                | 必填 | 默认值                      | 说明                                            |
| ------------------- | ---- | --------------------------- | ----------------------------------------------- |
| `apiKey`            | 是   | 无                          | API 密钥，只用于本次请求                        |
| `baseUrl`           | 否   | `https://api.openai.com/v1` | API base URL，或完整的 `chat/completions` URL   |
| `model`             | 是   | 无                          | 本次调用使用的模型 ID                           |
| `systemPrompt`      | 是   | 无                          | system 消息                                     |
| `userPrompt`        | 是   | 无                          | user 消息                                       |
| `temperature`       | 否   | `0`                         | 取值范围 `0..2`                                 |
| `maxRetries`        | 否   | `2`                         | 失败后的最大重试次数，取值范围 `0..10`          |
| `retryDelayMs`      | 否   | `500`                       | 指数退避的初始间隔，取值范围 `0..60000`         |
| `timeoutMs`         | 否   | `30000`                     | 每次 HTTP 尝试的超时时间，取值范围 `1..300000`  |
| `apiKeyHeader`      | 否   | `Authorization`             | 非 Bearer 服务可设置为 `api-key` 等 header 名称 |
| `additionalHeaders` | 否   | 无                          | provider 要求的额外 HTTP headers                |
| `signal`            | 否   | 无                          | 调用方提供的 `AbortSignal`，用于取消整个调用    |

当 `apiKeyHeader` 为 `Authorization` 时，接口发送 `Bearer <apiKey>`；使用其他 header 名称时直接发送密钥值。

## URL 规则

- `https://gateway.example/v1` 会转换为 `https://gateway.example/v1/chat/completions`。
- 已以 `/chat/completions` 结尾的完整地址保持不变。
- URL query 会保留，可用于 Azure 等需要 `api-version` 的兼容服务。
- 仅允许 `http` 和 `https` 协议。
- 请求使用 `redirect: "error"`，不会自动跟随 provider 重定向。
- 通用 service 本身允许调用任意 HTTP(S) host；HTTPS 默认策略和 hostname allowlist 由应用 API 网关提供。

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

`model` 优先使用 provider 响应中的模型 ID；provider 未返回时使用请求值。`usage` 和 `requestId` 取决于 provider 是否返回相应数据。

## 重试与错误

以下情况归类为 `retryable`：

- HTTP `408`、`409`、`429`；
- HTTP `5xx`；
- 网络错误；
- 单次请求超时；
- 错误 HTTP 响应的 body 不是合法 JSON。

重试间隔为 `retryDelayMs * 2^(attempt - 1)`，单次最多等待 60 秒。如果响应包含合法的 `Retry-After` header，则优先使用 provider 指定的等待时间，但同样受 60 秒上限约束。调用方的 `AbortSignal` 可以同时中断在途 fetch 和重试等待。

配置错误、鉴权错误、普通 `4xx`、成功响应中的非法 JSON 或空内容不会重试。所有错误统一为 `OpenAiCompatibleError`：

| `kind`          | 含义                                    |
| --------------- | --------------------------------------- |
| `configuration` | 请求字段或 URL 配置非法，请在发送前修正 |
| `retryable`     | 临时 provider、限流、网络或超时错误     |
| `non-retryable` | 鉴权、请求、协议或响应内容错误          |
| `cancelled`     | 调用方的 `AbortSignal` 已取消           |

错误还包含 `attempts`，HTTP 错误可能包含 `status`。接口在达到 `maxRetries` 后抛出最后一次错误。

## 日志与安全边界

结构化日志只记录事件名、模型、endpoint、尝试次数、耗时、状态、usage 和错误分类，不记录 provider 原始错误消息、API key、Prompt 或模型回答。endpoint 的 query 和 hash 在日志中会移除。HTTP 请求不会自动跟随重定向，调用方必须提供最终 provider 地址。

生产接入还必须在应用层完成以下控制：

- 不把 API key 写入数据库、普通日志、错误响应或浏览器持久存储；
- 对 UI 可提交的 provider host 建立 allowlist，避免任意 URL 造成 SSRF；
- 对 `additionalHeaders` 和完整 URL 做权限控制；
- 限制请求大小、用户调用频率、模型范围和成本预算；
- 根据数据合规要求决定 Prompt 是否允许发送给第三方 provider；
- 如果调用属于正式工作流，应通过 adapter 接入 `KaguyaLlmClient`，保留 schema 校验与 `llm_traces`。

## 当前限制

- 仅实现 OpenAI-compatible chat completions 文本响应；
- 暂不支持流式输出、tools/function calling、多模态输入和 embedding；
- 不负责保存模型配置、密钥或调用历史；
- 仓库当前没有 Web UI，本接口只提供 UI 后端可调用的 TypeScript 边界；
- demo 仍使用确定性 mock model，不会访问远端 API。
