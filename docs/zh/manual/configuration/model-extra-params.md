---
title: 模型额外参数
titleTemplate: :title · 模型高级参数
---

# 模型额外参数 (extra_params)

`model_config.toml` 中每个模型都可以设置 `extra_params` 字段，用于在 API 调用时传递服务商特有的参数。最常见的用途是控制大模型的思考模式和推理强度。

`extra_params` 不会以原样整体发送给服务商，实际请求前客户端会按规则拆分转换：

- **`headers`** — 作为请求头传入
- **`query`** — 作为 URL 查询参数传入
- **`body`** — 合并到请求体
- **其他普通键** — 作为请求体额外字段传入（OpenAI SDK 的 `extra_body`）

当 `client_type = "google"` 时，`extra_params` 不按上述规则拆分，而是由 Gemini 客户端按自身支持的字段筛选和映射到 `GenerateContentConfig`。

---

# 思考与非思考模式

很多大模型支持"思考模式"，让模型在回答前先进行深度推理，从而提升复杂问题的回答质量。MaiBot 支持两种 API 体系，配置方式不同：

- **OpenAI 兼容 API**（`client_type = "openai"`）：DeepSeek、OpenAI、阿里云百炼等
- **Gemini 原生 API**（`client_type = "google"`）：Google Gemini 系列

## OpenAI 兼容 API

`thinking` 对象是多家服务商通用的思考模式开关，**DeepSeek**、**Kimi（月之暗面）**、**GLM（智谱）** 等均采用此格式，配置方式完全一致。`reasoning_effort` 为可选参数，不填则使用默认强度。部分第三方平台（如阿里云百炼/DashScope）则使用 `enable_thinking` 参数格式：

::: code-group

```toml [官方（思考） ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-think"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
visual = false
extra_params = {thinking = {type = "enabled"}, reasoning_effort = "high"}
```

```toml [官方（非思考） ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-nothink"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
visual = false
extra_params = {thinking = {type = "disabled"}}
```

```toml [官方（极限） ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-max"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
visual = false
extra_params = {thinking = {type = "enabled"}, reasoning_effort = "max"}
```

```toml [第三方（思考） ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-think"
model_identifier = "deepseek-v4-flash"
api_provider = "dashscope"
visual = false
extra_params = {enable_thinking = true}
```

```toml [第三方（非思考） ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-nothink"
model_identifier = "deepseek-v4-flash"
api_provider = "dashscope"
visual = false
extra_params = {enable_thinking = false}
```

:::

**要点：**

- DeepSeek V4 的 `reasoning_effort` 仅支持 `high`（默认）和 `max`（极限推理）两个有效等级。`low`/`medium` 映射为 `high`，`xhigh` 映射为 `max`
- 对比 OpenAI：OpenAI 的 `reasoning_effort` 支持 6 个独立等级（`none`/`minimal`/`low`/`medium`（默认）/`high`/`xhigh`），各自独立生效，与 DeepSeek V4 只有 2 个有效等级不同。注意 `o1-mini` 不支持此参数
- **多轮对话规则**：如果思考轮次没有工具调用，不需要把思考内容回传；如果有工具调用，必须回传
- **限制**：思考模式下 `temperature` 和 `top_p` 会被静默忽略，`tool_choice` 会导致 400 错误
- 第三方平台（如阿里云百炼/DashScope）使用 `enable_thinking`（布尔值）控制思考模式，与原生 `thinking` 对象写法不同。配置前请确认你使用的平台支持哪种参数格式

## Responses API

部分服务商（如 DeepSeek v4 flash 联网搜索）使用 OpenAI 的 **Responses 协议**，需要在服务商配置中设置 `client_type = "openai_responses"`。Responses API 的参数格式与 Chat Completions 略有不同：

- **思考模式**：使用 `reasoning = {effort = "..."}` 而不是 `thinking`/`reasoning_effort`，`effort` 可选 `none` / `low` / `high` / `max`
- **联网搜索**：把 `web_search` 原生工具写入 `tools` 列表即可启用

::: code-group

```toml [Responses（思考） ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-responses-think"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
client_type = "openai_responses"
extra_params = {reasoning = {effort = "high"}}
```

```toml [Responses（非思考） ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-responses-nothink"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
client_type = "openai_responses"
extra_params = {reasoning = {effort = "none"}}
```

```toml [Responses（联网搜索） ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-responses-web"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
client_type = "openai_responses"
extra_params = {reasoning = {effort = "high"}, tools = [{type = "web_search"}]}
```

:::

**要点：**

- Responses 客户端中不要再写 `thinking` 或 `reasoning_effort`，请统一使用 `reasoning.effort`，否则会被校验拒绝
- `reasoning.effort` 比 Chat Completions 多一个 `none`（完全关闭思考）
- `web_search` 工具通过 `extra_params.body.tools` 传入（`body` 分组的字段与其他普通键会合并进请求体，见 [自定义 HTTP 请求](#自定义-http-请求)）
- DeepSeek 的 Chat Completions 端点不支持原生联网搜索，使用联网搜索必须选择 `openai_responses` 客户端
- Maisaka 监控页与日志会展示联网搜索摘要（本轮查询、动作、状态和来源数量）

## Gemini 原生 API

当 `client_type = "google"` 时，`extra_params` 不按 OpenAI 的 `headers/query/body` 规则处理，而是由 Gemini 客户端按自身支持的字段筛选和映射到 `GenerateContentConfig`。

### Gemini 2.5（thinking_budget）

Gemini 2.5 系列通过 `thinking_budget`（整数）控制思考预算：

::: code-group

```toml [开启思考 ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-2.5-flash-think"
model_identifier = "gemini-2.5-flash"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_budget = 4096, include_thoughts = true}}
```

```toml [关闭思考 ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-2.5-flash-nothink"
model_identifier = "gemini-2.5-flash"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_budget = 0}}
```

```toml [自动预算 ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-2.5-pro-think"
model_identifier = "gemini-2.5-pro"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_budget = -1, include_thoughts = true}}
```

:::

**要点：**

- `thinking_budget`：`-1` = 自动分配，`0` = 关闭思考，`N` = 指定 token 预算
- `include_thoughts`：是否在响应中包含思考过程
- 已知问题：Flash Preview 04-17 版本设置 `thinking_budget = 0` 可能失败

### Gemini 3.0+（thinking_level）

Gemini 3.0 及更新版本通过 `thinking_level`（枚举值）控制思考强度：

::: code-group

```toml [高强度思考 ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-3-flash-high"
model_identifier = "gemini-3-flash"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_level = "high", include_thoughts = true}}
```

```toml [低强度思考 ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-3-flash-low"
model_identifier = "gemini-3-flash"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_level = "low", include_thoughts = true}}
```

:::

**要点：**

- `thinking_level` 可选：`minimal`、`low`、`medium`、`high`
- 不要同时使用 `thinking_budget` 和 `thinking_level`，会导致 400 错误
- 多轮对话中需要使用 thought signatures 保持上下文

### Gemini 总览

- **Gemini 2.5** — 通过 `thinking_budget` 控制思考预算，值域：`-1`（自动）/ `0`（关闭）/ `N`（预算），关闭方式为 `budget = 0`。budget 和 level 不可混用
- **Gemini 3.0+** — 通过 `thinking_level` 控制思考等级，值域：`minimal` / `low` / `medium` / `high`，关闭方式为不设置或 `minimal`。不支持 token 级预算控制

Gemini 2.5 使用 token 数量间接控制强度，`-1` 为自动分配。Gemini 3.0+ 使用枚举值直接指定等级。

> Google API 在国内无法直接访问，需要代理。

# 自定义 HTTP 请求

`extra_params` 支持三个特殊 key 来精确控制 API 请求：

- **`headers`** — 添加 HTTP 请求头，如 `{headers = {"X-Custom" = "value"}}`
- **`query`** — 添加 URL 查询参数，如 `{query = {"key" = "value"}}`
- **`body`** — 其中的字段与其他普通键一起进入请求体，仅用于在配置中按用途分组

::: warning 注意
`body` 并不创建独立的请求通道。`body` 内的字段和 `headers`/`query` 之外的**所有普通键**会合并后一起发送到请求体中。
:::

例如：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[[models]]
name = "custom-model"
model_identifier = "custom-model-v1"
api_provider = "custom"
visual = false
extra_params = {
  headers = {"X-API-Version" = "2024-06", "X-Priority" = "high"},
  query = {version = "2024-01-01"},
  body = {metadata = {source = "maibot"}},
  enable_thinking = false
}
```

:::

客户端拆分后的实际效果：

**`headers`** — HTTP 请求头：`X-API-Version: 2024-06`，`X-Priority: high`
**`query`** — URL 查询参数：`?version=2024-01-01`
**`body` 内字段 + 其他普通键** — 请求体 JSON：`{"metadata": {"source": "maibot"}, "enable_thinking": false}`

所以 `extra_params = {enable_thinking = "false"}` 等价于 `extra_params = {body = {enable_thinking = "false"}}`，都会把 `enable_thinking` 作为请求体 JSON 字段发给服务商，而不是发送嵌套的 `{"extra_params": {"enable_thinking": "false"}}`。

# 高级鉴权配置

- **`auth_header_name`** — Header 鉴权名称。默认 `Authorization`
- **`auth_header_prefix`** — Header 鉴权前缀。默认 `Bearer`
- **`auth_query_name`** — Query 鉴权参数名。默认 `api_key`

# 其他高级参数

## 模型级参数覆盖

- **`temperature`** — 模型级温度，覆盖任务配置。可选，如 `0.7`
- **`max_tokens`** — 模型级最大 token，覆盖任务配置。可选，如 `4096`
- **`force_stream_mode`** — 强制流式输出，不支持非流式时设为 `true`。默认关闭
- **`extra_params`** — 额外参数字典。默认为空

## 优先级说明

`temperature` 和 `max_tokens` 可以写在 `extra_params` 中作为模型级默认值，但更推荐使用模型配置里的同名独立字段：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
temperature = 0.7
max_tokens = 4096
```

:::

这样配置意图更清楚，也能避免和服务商请求体中的同名字段混淆。

当多处存在同名参数时，生效优先级为：

1. 调用方本次请求显式传入的值
2. 当前模型配置里的独立字段（如 `temperature`、`max_tokens`）
3. 当前模型 `extra_params` 中的同名字段
4. 当前任务配置中的默认值

## API 提供商高级配置

- **`default_headers`** — 默认 HTTP 头。默认为空
- **`default_query`** — 默认查询参数。默认为空
- **`organization`** — OpenAI 组织（可选）。默认无
- **`project`** — OpenAI 项目（可选）。默认无
- **`model_list_endpoint`** — 模型列表端点。默认 `/models`
- **`reasoning_parse_mode`** — 推理内容解析模式。默认 `auto`
- **`tool_argument_parse_mode`** — 工具参数解析模式。默认 `auto`

## 运行时配置

- **`timeout`** — 超时时间。推荐 60 秒
- **`max_retry`** — 失败重试次数。推荐 3 次
- **`retry_interval`** — 重试间隔。推荐 5 秒

# 常用参数速查

## OpenAI 兼容 API

- **`thinking`** — 思考模式控制，含 `type`（enabled/disabled）。适用 DeepSeek
- **`reasoning_effort`** — 推理强度等级（DeepSeek V4 仅 high/max，OpenAI 6 级）。适用 DeepSeek, OpenAI
- **`enable_thinking`** — 开启思考模式。适用阿里云百炼
- **`reasoning`** — Responses API 思考控制，含 `effort`（none/low/high/max）。适用 DeepSeek（Responses 客户端）
- **`tools`** — 原生工具列表，如 `{type = "web_search"}` 开启联网搜索。适用 DeepSeek Responses 客户端
- **`headers`** — 自定义 HTTP 请求头。适用全部
- **`query`** — 自定义 URL 查询参数。适用全部
- **`body`** — 自定义请求体字段。适用全部

## Gemini 原生 API

- **`thinking_config`** — 思考配置，含 `thinking_budget` 或 `thinking_level`。适用 Gemini 全系
- **`thinking_budget`** — 思考预算（-1 自动 / 0 关闭 / N 指定）。适用 Gemini 2.5
- **`thinking_level`** — 思考等级（minimal/low/medium/high）。适用 Gemini 3.0+
- **`include_thoughts`** — 响应是否包含思考过程。适用 Gemini 全系

> 参数会原样传递给 LLM API，务必与你使用的服务商文档一致，否则可能导致调用失败。

---

**更多信息请参考各服务商官方文档：**

- [DeepSeek API 文档](https://api-docs.deepseek.com/guides/thinking_mode)
- [OpenAI 推理指南](https://platform.openai.com/docs/guides/reasoning)
- [Google Gemini 思考配置](https://cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- [阿里云百炼 API 参考](https://help.aliyun.com/zh/model-studio/developer-reference/)
- [Kimi 思考模式指南](https://platform.kimi.com/docs/guide/use-kimi-k2-thinking-model)
- [GLM 思考模式文档](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)
