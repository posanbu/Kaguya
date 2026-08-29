---
title: Model Extra Parameters
titleTemplate: :title · Model Advanced Parameters
---

# Model Extra Parameters (extra_params)

Every model in `model_config.toml` can have an `extra_params` field, used to pass provider-specific parameters when making API calls. Its most common use is controlling the model's thinking mode and reasoning intensity.

`extra_params` is not sent to the provider verbatim — before the actual request, the client splits and converts it according to the following rules:

- **`headers`** — Sent as request headers
- **`query`** — Sent as URL query parameters
- **`body`** — Merged into the request body
- **Other plain keys** — Sent as extra fields of the request body (the OpenAI SDK's `extra_body`)

When `client_type = "google"`, `extra_params` is not split by the rules above; instead, the Gemini client filters and maps it to `GenerateContentConfig` according to the fields it supports.

---

# Thinking and Non-thinking Modes

Many LLMs support a "thinking mode" that performs deep reasoning before answering, improving answer quality on complex problems. MaiBot supports two API families with different configuration approaches:

- **OpenAI-compatible APIs** (`client_type = "openai"`): DeepSeek, OpenAI, Alibaba Cloud Bailian, etc.
- **Gemini native API** (`client_type = "google"): the Google Gemini family

## OpenAI-compatible APIs

The `thinking` object is a common thinking-mode switch shared by many providers — **DeepSeek**, **Kimi (Moonshot)**, **GLM (Zhipu)** all use this format with identical configuration. `reasoning_effort` is optional; leave it out to use the default intensity. Some third-party platforms (e.g. Alibaba Cloud Bailian/DashScope) instead use the `enable_thinking` parameter format:

::: code-group

```toml [Official (thinking) ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-think"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
visual = false
extra_params = {thinking = {type = "enabled"}, reasoning_effort = "high"}
```

```toml [Official (non-thinking) ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-nothink"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
visual = false
extra_params = {thinking = {type = "disabled"}}
```

```toml [Official (max) ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-max"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
visual = false
extra_params = {thinking = {type = "enabled"}, reasoning_effort = "max"}
```

```toml [Third-party (thinking) ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-think"
model_identifier = "deepseek-v4-flash"
api_provider = "dashscope"
visual = false
extra_params = {enable_thinking = true}
```

```toml [Third-party (non-thinking) ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-nothink"
model_identifier = "deepseek-v4-flash"
api_provider = "dashscope"
visual = false
extra_params = {enable_thinking = false}
```

:::

**Key points:**

- DeepSeek V4's `reasoning_effort` only supports two valid levels: `high` (default) and `max` (max reasoning). `low`/`medium` map to `high`, and `xhigh` maps to `max`
- Compare with OpenAI: OpenAI's `reasoning_effort` supports 6 independent levels (`none`/`minimal`/`low`/`medium` (default)/`high`/`xhigh`), each taking effect independently, unlike DeepSeek V4's 2 valid levels. Note that `o1-mini` does not support this parameter
- **Multi-turn rule**: if a thinking turn has no tool calls, you don't need to send back the thinking content; if it has tool calls, you must send it back
- **Limitations**: in thinking mode, `temperature` and `top_p` are silently ignored, and `tool_choice` causes a 400 error
- Third-party platforms (e.g. Alibaba Cloud Bailian/DashScope) use `enable_thinking` (boolean) to control thinking mode, which differs from the native `thinking` object. Confirm which parameter format your platform supports before configuring

## Gemini Native API

When `client_type = "google"`, `extra_params` is not processed with OpenAI's `headers/query/body` rules; instead the Gemini client filters fields it supports and maps them to `GenerateContentConfig`.

### Gemini 2.5 (thinking_budget)

The Gemini 2.5 family controls the thinking budget via `thinking_budget` (integer):

::: code-group

```toml [Enable thinking ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-2.5-flash-think"
model_identifier = "gemini-2.5-flash"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_budget = 4096, include_thoughts = true}}
```

```toml [Disable thinking ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-2.5-flash-nothink"
model_identifier = "gemini-2.5-flash"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_budget = 0}}
```

```toml [Auto budget ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-2.5-pro-think"
model_identifier = "gemini-2.5-pro"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_budget = -1, include_thoughts = true}}
```

:::

**Key points:**

- `thinking_budget`: `-1` = auto-allocate, `0` = thinking off, `N` = specified token budget
- `include_thoughts`: whether to include the thinking process in the response
- Known issue: the Flash Preview 04-17 build may fail with `thinking_budget = 0`

### Gemini 3.0+ (thinking_level)

Gemini 3.0 and newer control thinking intensity via `thinking_level` (enum):

::: code-group

```toml [High-intensity thinking ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-3-flash-high"
model_identifier = "gemini-3-flash"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_level = "high", include_thoughts = true}}
```

```toml [Low-intensity thinking ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-3-flash-low"
model_identifier = "gemini-3-flash"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_level = "low", include_thoughts = true}}
```

:::

**Key points:**

- `thinking_level` options: `minimal`, `low`, `medium`, `high`
- Don't use `thinking_budget` and `thinking_level` together — it causes a 400 error
- Multi-turn conversations require thought signatures to preserve context

### Gemini Overview

- **Gemini 2.5** — controls the thinking budget via `thinking_budget`, values: `-1` (auto) / `0` (off) / `N` (budget); turn off with `budget = 0`. Budget and level cannot be mixed
- **Gemini 3.0+** — controls thinking level via `thinking_level`, values: `minimal` / `low` / `medium` / `high`; turn off by not setting it or using `minimal`. No token-level budget control

Gemini 2.5 indirectly controls intensity through the token count, where `-1` is auto-allocated. Gemini 3.0+ directly specifies the level with enum values.

> The Google API is not directly accessible in mainland China and requires a proxy.

# Custom HTTP Requests

`extra_params` supports three special keys for precise control of API requests:

- **`headers`** — Add HTTP request headers, e.g. `{headers = {"X-Custom" = "value"}}`
- **`query`** — Add URL query parameters, e.g. `{query = {"key" = "value"}}`
- **`body`** — Its fields go into the request body together with other plain keys; it only groups fields by purpose in the configuration

::: warning Note
`body` does not create a separate request channel. The fields inside `body` and **all plain keys** other than `headers`/`query` are merged and sent to the request body together.
:::

For example:

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

The actual effect after the client splits it:

**`headers`** — HTTP request headers: `X-API-Version: 2024-06`, `X-Priority: high`
**`query`** — URL query parameters: `?version=2024-01-01`
**`body` fields + other plain keys`** — request body JSON: `{"metadata": {"source": "maibot"}, "enable_thinking": false}`

So `extra_params = {enable_thinking = "false"}` is equivalent to `extra_params = {body = {enable_thinking = "false"}}` — both send `enable_thinking` as a JSON field of the request body to the provider, rather than sending a nested `{"extra_params": {"enable_thinking": "false"}}`.

# Advanced Auth Configuration

- **`auth_header_name`** — Header auth name. Default `Authorization`
- **`auth_header_prefix`** — Header auth prefix. Default `Bearer`
- **`auth_query_name`** — Query auth parameter name. Default `api_key`

# Other Advanced Parameters

## Model-level Parameter Overrides

- **`temperature`** — Model-level temperature, overrides the task configuration. Optional, e.g. `0.7`
- **`max_tokens`** — Model-level max tokens, overrides the task configuration. Optional, e.g. `4096`
- **`force_stream_mode`** — Force streaming output; set to `true` if the model doesn't support non-streaming. Off by default
- **`extra_params`** — Extra parameter dictionary. Empty by default

## Priority Rules

`temperature` and `max_tokens` can be written in `extra_params` as model-level defaults, but it is recommended to use the same-named standalone fields in the model configuration:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
temperature = 0.7
max_tokens = 4096
```

:::

This makes the configuration intent clearer and avoids confusion with same-named fields in the provider request body.

When the same-named parameter exists in multiple places, the effective priority is:

1. The value explicitly passed by the caller in this request
2. Standalone fields in the current model config (e.g. `temperature`, `max_tokens`)
3. Same-named fields in the current model's `extra_params`
4. Defaults in the current task configuration

## API Provider Advanced Configuration

- **`default_headers`** — Default HTTP headers. Empty by default
- **`default_query`** — Default query parameters. Empty by default
- **`organization`** — OpenAI organization (optional). None by default
- **`project`** — OpenAI project (optional). None by default
- **`model_list_endpoint`** — Model list endpoint. Default `/models`
- **`reasoning_parse_mode`** — Reasoning content parse mode. Default `auto`
- **`tool_argument_parse_mode`** — Tool argument parse mode. Default `auto`

## Runtime Configuration

- **`timeout`** — Timeout. 60 seconds recommended
- **`max_retry`** — Failed-request retries. 3 retries recommended
- **`retry_interval`** — Retry interval. 5 seconds recommended

# Quick Parameter Reference

## OpenAI-compatible APIs

- **`thinking`** — Thinking-mode control, contains `type` (enabled/disabled). Applies to DeepSeek
- **`reasoning_effort`** — Reasoning intensity level (DeepSeek V4 only high/max; OpenAI has 6 levels). Applies to DeepSeek, OpenAI
- **`enable_thinking`** — Enable thinking mode. Applies to Alibaba Cloud Bailian
- **`headers`** — Custom HTTP request headers. Applies to all
- **`query`** — Custom URL query parameters. Applies to all
- **`body`** — Custom request body fields. Applies to all

## Gemini Native API

- **`thinking_config`** — Thinking configuration, contains `thinking_budget` or `thinking_level`. Applies to the whole Gemini family
- **`thinking_budget`** — Thinking budget (-1 auto / 0 off / N specified). Applies to Gemini 2.5
- **`thinking_level`** — Thinking level (minimal/low/medium/high). Applies to Gemini 3.0+
- **`include_thoughts`** — Whether the response includes the thinking process. Applies to the whole Gemini family

> Parameters are passed to the LLM API verbatim — make sure they match your provider's documentation, otherwise calls may fail.

---

**More information in each provider's official documentation:**

Many large models support "thinking mode" — letting the model perform deep reasoning before answering, improving response quality for complex questions.

### DeepSeek

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-r1"
model_identifier = "deepseek-reasoner"
api_provider = "deepseek"
visual = false
extra_params = {enable_thinking = true}   # Enable thinking mode
```

:::

- **`enable_thinking`** — `true` to enable thinking, `false` to disable

## Adjusting Reasoning Depth

OpenAI's reasoning models use the `reasoning_effort` parameter to control reasoning depth.

- **`none`** — Simple Q&A, information retrieval. Fastest, no reasoning
- **`minimal`** — Minimal reasoning. Almost no added latency
- **`low`** — Tool calls, search, multi-step decisions. Light reasoning
- **`medium`** — Planning, complex reasoning (default). Balance of quality and speed
- **`high`** — Complex debugging, deep planning. Quality prioritized
- **`xhigh`** — Deep research, async tasks. Highest quality, maximum latency

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[[models]]
name = "gpt-5"
model_identifier = "gpt-5.5"
api_provider = "openai"
visual = false
extra_params = {reasoning_effort = "medium"}
```

:::

> 💡 **Recommendation**: Use `medium` for daily use, `low` for speed-sensitive tasks, `high` for deep analysis.

## Responses API

Some providers (e.g. DeepSeek v4 flash web search) use the OpenAI **Responses protocol**. Set `client_type = "openai_responses"` in the provider config. The parameter format differs from Chat Completions:

- **Thinking**: use `reasoning = {effort = "..."}` instead of `thinking` / `reasoning_effort`. `effort` accepts `none` / `low` / `high` / `max`
- **Web search**: add the `web_search` native tool to the `tools` list to enable it

::: code-group

```toml [Responses (thinking) ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-responses-think"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
client_type = "openai_responses"
extra_params = {reasoning = {effort = "high"}}
```

```toml [Responses (non-thinking) ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-responses-nothink"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
client_type = "openai_responses"
extra_params = {reasoning = {effort = "none"}}
```

```toml [Responses (web search) ~vscode-icons:file-type-toml~]
[[models]]
name = "deepseek-v4-flash-responses-web"
model_identifier = "deepseek-v4-flash"
api_provider = "deepseek"
client_type = "openai_responses"
extra_params = {reasoning = {effort = "high"}, tools = [{type = "web_search"}]}
```

:::

**Key Points:**

- On the Responses client, do not use `thinking` or `reasoning_effort`; always use `reasoning.effort`, otherwise validation rejects the config
- `reasoning.effort` adds `none` (fully disable thinking) compared to Chat Completions
- The `web_search` tool is passed via `extra_params.body.tools` (fields grouped under `body` and other plain keys are merged into the request body, see [Custom HTTP Requests](#custom-http-requests))
- DeepSeek's Chat Completions endpoint does not support native web search; you must use the `openai_responses` client for web search
- The Maisaka monitor and logs display web search summaries (query, action, status and source count for the round)

## About client_type and Gemini

`client_type` determines which client MaiBot uses to communicate with the API:

- **`openai`** — OpenAI-compatible interface (default), works with DeepSeek, Alibaba Bailian, OpenAI, etc.
- **`google`** — Google Gemini native interface, supports thinking budget control

### Gemini Thinking Configuration

Gemini models use `thinking_config` in `extra_params` to control thinking:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[[models]]
name = "gemini-2.5-flash"
model_identifier = "gemini-2.5-flash"
api_provider = "google-gemini"
visual = true
client_type = "google"
extra_params = {thinking_config = {thinking_budget = 4096}}
```

:::

> ⚠️ Google API is not directly accessible in China. You'll need a proxy.

### Gemini Extra Parameter Fields

When `client_type = "google"`, `extra_params` does not follow the OpenAI-compatible `headers/query/body` splitting rules. The Gemini client filters and maps fields according to what it supports:

- Content generation: mapped to supported `GenerateContentConfig` fields
- Embeddings: mapped to supported `EmbedContentConfig` fields

- **`thinking_budget`** — Thinking budget (token count)
- **`include_thoughts`** — Whether to include thinking process in responses
- **`enable_google_search`** — Enable Google search capability
- **`task_type`** — Embedding task type
- **`output_dimensionality`** — Embedding output dimensionality
- **`audio_mime_type`** — MIME type for audio requests

## Custom HTTP Requests

`extra_params` supports three special keys for precise API request control:

- **`headers`** — Add HTTP request headers, e.g. `{headers: {"X-Custom": "value"}}`
- **`query`** — Add URL query parameters, e.g. `{query: {"key": "value"}}`
- **`body`** — Override request body fields, e.g. `{body: {"field": "value"}}`

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[[models]]
name = "custom-model"
model_identifier = "custom-model-v1"
api_provider = "custom"
visual = false
extra_params = {headers = {"X-API-Version" = "2024-06", "X-Priority" = "high"}}
```

:::

## Combining Parameters

You can use multiple parameters together:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[[models]]
name = "gpt-5-advanced"
model_identifier = "gpt-5.5"
api_provider = "openai"
visual = true
extra_params = {
    reasoning_effort = "high",
    headers = {"X-Request-ID" = "custom-id", "X-Priority" = "high"}
}
```

:::

## Quick Parameter Reference

- **`enable_thinking`** — Enable thinking mode. Providers: DeepSeek
- **`reasoning_effort`** — Reasoning depth level. Providers: OpenAI
- **`reasoning`** — Responses API thinking control, with `effort` (`none`/`low`/`high`/`max`). Providers: DeepSeek (Responses client)
- **`tools`** — Native tool list, e.g. `{type = "web_search"}` enables web search. Providers: DeepSeek Responses client
- **`headers`** — Custom HTTP request headers. Providers: All
- **`query`** — Custom URL query parameters. Providers: All
- **`body`** — Custom request body fields. Providers: All
- **`thinking_config`** — Thinking budget config. Providers: Gemini

> ⚠️ **Note**: Parameters are passed directly to the LLM API. Ensure parameter names and value formats match your provider's documentation, otherwise API calls may fail.
