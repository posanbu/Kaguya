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

## TTS 接口（#214，可选在线出口）

包根导出 `TtsProvider`、`TtsIdentity`、`TtsAudio`、`TtsError`、`ttsTaskKey`
和 `createQwenTtsProvider`、`createQwenVoiceManager`。导入这些底层接口没有网络副作用，
默认不会执行付费请求或发送 QQ 语音。显式注入 `MessageCompositionOptions.tts`
后可启用 Heavy → TTS → Runtime 链路；Server 读取 Profile provider 的 settings.tts 和既有 apiKey。
音色管理和部署方法见 [QQ 语音回复](../../docs/guide/tts.md)。

调用方必须显式指定非秘密 `accountScope`、区域、模型、账号可用的音色 ID 和语言，
以及可信下载 OSS 主机的精确名单 `audioHosts`。不内置八千代音色 ID，也不保证其他账号
下的音色可用。`apiKey` 只保留在客户端闭包，不属于可序列化身份或任务键。
北京和新加坡使用不同的固定 API 地址；创建音色的账号、区域和目标模型必须与合成一致。

客户端接受 1–600 字符的非空原文，不清洗或改写已授权正文。默认总超时 30 秒，
音频上限 10 MiB，JSON 响应上限 64 KiB；均拒绝 HTTP 重定向。
旧 API 返回的 HTTP OSS 链接仅在主机明确获准时升级 HTTPS，下载不携带 API key。
首版仅接受结构完整的 PCM WAV（RIFF 长度、fmt、采样参数、data 边界均校验），
不转码、不依赖本地播放器。返回字节、SHA-256、时长和实际合成文本，不返回临时 URL。

返回的 `bytes` 必须由后续资源存储持久化，不能写入 InformationAtom；完成此存储之前
不能把客户端结果当作持久化产物。`ttsTaskKey` 包含来源、原文、账号和合成参数，
供后续登记/复用使用，本函数不实现缓存、锁或事件去重。

客户端不自动重试。超时、取消或网络故障并不证明远端没有合成或计费；调用方不能把
这类结果作为安全自动重试的依据。错误只含固定分类，不附带原始响应、URL、正文或密钥。
取消/超时之后不会下载迟到的合成结果；这一保证不等于取消远端已提交的任务。

HTTP 请求实现依据[阿里云 Qwen-TTS API](https://www.alibabacloud.com/help/zh/model-studio/qwen-tts-api)，
未复制 issue 引用项目的实现。真实音色、音质及 QQ 可发送格式仍需单独联调。
