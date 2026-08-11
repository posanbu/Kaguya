# LLM Client

`@kaguya/llm/client` 是 Kaguya 工作流唯一的文本生成边界。它基于 Vercel AI SDK Core 的 `LanguageModel` 与 `generateText`，不直接依赖 OpenAI、Anthropic、Google 等供应商 SDK，也不手写供应商 HTTP 请求。

Issue #6 要求 LLM client 使用 Vercel AI SDK，并作为独立模块提供。当前包按职责拆分为以下子路径：

| 子路径                          | 职责                                                           |
| ------------------------------- | -------------------------------------------------------------- |
| `@kaguya/llm/client`            | 生成调用、错误归一化、业务输出校验和 `llm_traces` 写入         |
| `@kaguya/llm/schemas`           | route、reply、state、memory 四类输出 schema 与 TypeScript 类型 |
| `@kaguya/llm/openai-compatible` | 基于 `@ai-sdk/openai-compatible` 的动态 provider adapter       |
| `@kaguya/llm/testing`           | 基于 `ai/test` 的确定性测试模型                                |

包根路径 `@kaguya/llm` 继续导出上述 API，保持现有调用兼容；新代码应优先使用具体子路径，让生产 client、provider adapter 和测试工具保持明确边界。

## 创建 Client

调用方负责创建 Vercel AI SDK `LanguageModel`，并把 trace writer、时钟和 ID 生成器注入 client：

```ts
import { KaguyaLlmClient } from "@kaguya/llm/client";

const client = new KaguyaLlmClient({
  model,
  traceWriter,
  now: () => new Date(),
  nextId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
});
```

工作流调用 `generate` 时必须传入完整的 compiled Prompt 和关联字段：

```ts
const result = await client.generate({
  kind: "reply",
  modelId: "provider-model-id",
  prompt,
  traceId,
  workflowId: "message-workflow",
  nodeId: "generate-reply",
});
```

`kind` 决定返回类型。四类结果都会在返回工作流之前进行严格 schema 校验；非法 JSON、字段缺失、额外字段或空白业务文本会归类为 `non-retryable`。

## Vercel AI SDK 边界

- client 接受 Vercel AI SDK 的统一 `LanguageModel`，业务工作流不导入供应商 SDK；
- client 使用 `generateText` 发起生成并读取统一 usage；
- provider 选择和凭证解析由 composition root 或独立 adapter 完成；
- SDK 的 `APICallError` 与 `RetryError` 会归一化为 `retryable`、`non-retryable` 或 `cancelled`；
- client 不维护另一套 HTTP、重试或供应商响应解析实现；
- `@kaguya/llm/testing` 使用 `ai/test` 的 `MockLanguageModelV3`，测试不会调用远端模型。

OpenAI-compatible 动态调用的 URL、鉴权、超时和重试配置见 [OpenAI-compatible LLM 接口](openai-compatible-llm.md)。该 adapter 与工作流 client 是两个独立模块；正式工作流应在 composition root 中把 provider model 接入 `KaguyaLlmClient`，而不是让 HTTP 网关直接调用模型。

## Trace 与错误

每次生成都会先尝试写入一条成功或失败 trace。trace 包含调用关联 ID、workflow/node、model ID、完整 compiled Prompt、时间、耗时、usage、响应或规范化错误。

- 模型生成失败时，`KaguyaLlmError` 是主错误；trace 写入失败会附加到 `traceWriteError`；
- 模型生成成功但 trace 写入失败时，client 抛出 `TracePersistenceError`；
- client 不会因为 trace 写入失败而把已失败的模型调用误报为成功。

Prompt 和响应可能包含敏感用户内容。生产环境必须对 trace 存储实施访问控制、保留期限和删除策略。

## 测试

```powershell
pnpm exec vitest run packages/llm/src/index.test.ts
pnpm exec vitest run packages/llm/src/openai-compatible.test.ts
pnpm --filter @kaguya/llm typecheck
pnpm --filter @kaguya/llm build
```
