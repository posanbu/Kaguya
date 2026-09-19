# @kaguya/llm

Kaguya 的 Vercel AI SDK 模型边界。

- `@kaguya/llm/client`：模型生成、能力分流、本地校验与安全错误契约；
- `@kaguya/llm/schemas`：四类业务输出 schema；
- `@kaguya/llm/openai-compatible`：OpenAI-compatible provider adapter；
- `@kaguya/llm/testing`：基于 `ai/test` 的确定性模型。

## 结构化输出

`KaguyaLlmGenerationOptions.structuredOutputMode` 默认为 `json`：结构化任务通过 `Output.json()` 请求 JSON，再用调用方提供的 schema 在本地校验。该模式要求 schema 带有本地 validator；JSON 格式约束不等于服务端 JSON Schema 约束，不能据此认定 Provider 支持 `json_schema`。

Server 只在当前 tier 对应 Provider 的 `settings.supportsStructuredOutputs === true` 时选择 `schema`，通过 `Output.object({ schema })` 请求服务端结构化输出。该设置缺省或为 `false` 时保留 `json` 路径，不会替 Provider 伪造支持声明；思考参数、硬超时和推荐时长沿用当前 tier 配置。现有 OpenAI-compatible adapter 使用 Chat Completions，此次选择不增加 Responses API 支持。

`json` 路径首次遇到空输出、无效 JSON、schema 不匹配或截断时，最多再次请求一次。两次尝试共用一个 timeout/abort 生命周期，并累计已知 token usage；`schema` 路径只作一次结构化尝试。最终失败提供安全分类 `structuredOutputFailure`（`empty`、`invalid-json`、`schema-mismatch` 或 `truncated`）及 `attemptCount`，不把原始响应存入 Runtime 失败事实或日志。

Runtime 的 Model Task 给客户端提供由任务输入 JSON Schema 重建的校验器；原始任务 schema 的 transform、自定义 refinement，以及冻结索引与目标授权检查仍在上层执行。这些业务检查失败会安全闭合，不触发客户端的格式重试。

运行时边界见[运行时架构](../../docs/developers/architecture.md#结构化模型输出)。
