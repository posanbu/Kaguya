---
title: Profile API
description: Kaguya Profile Registry 的读取、创建、完整替换、选择与删除契约。
---

# Profile API

所有 Profile 路由都需要当前实例的 Bearer Token。`GET /api/v1/profiles` 是唯一的配置 readiness 入口，只返回无 secret 的状态和 Profile 摘要；读取单个 Profile 会返回 API Key 等可编辑敏感字段，只能在可信边界内调用。数据库 URL 等隐藏 `runtime` 字段不会通过 Web API 返回，只有其中的网关白名单被安全投影为顶层 `gatewayAllowlist`。

## 列出 Profile

`GET /api/v1/profiles` 返回全局 `selectedProfileId`、metadata 列表，以及 selected Profile 的 `invalid`、`review_required`、`restart_required` 或 `ready` 状态。`invalid` 可带 `issues`，`review_required` 可带 `warnings`；metadata 和诊断都不包含完整 Provider 凭据。

::: code-group

```bash [请求 ~vscode-icons:file-type-shell~]
curl http://127.0.0.1:3000/api/v1/profiles \
  -H "Authorization: Bearer replace-with-current-token"
```

```json [响应形状 ~vscode-icons:file-type-json~]
{
  "data": {
    "status": "invalid",
    "selectedProfileId": "default",
    "profiles": [
      {
        "id": "default",
        "name": "default",
        "createdAt": "2026-09-03T00:00:00.000Z",
        "updatedAt": "2026-09-03T00:00:00.000Z"
      }
    ],
    "issues": [
      {
        "id": "default-provider-missing",
        "path": "ai.providers",
        "message": "At least one AI provider is required."
      }
    ]
  }
}
```

:::

## 创建 Profile

`POST /api/v1/profiles` 只接收 `name`，创建未选中的 Profile 并返回 `201`。初始化文件会显式写入默认 Agent identity、空 AI、关闭的 Memory 与空平台；隐藏 runtime 继承当前 selected Profile，避免切换后无法启动。接口不会让 Runtime 自动切换。

::: code-group

```json [请求体 ~vscode-icons:file-type-json~]
{ "name": "实验模型" }
```

:::

响应返回 Web 可编辑的 `profile` 和 `restartRequired`。新 Profile 的 Provider、平台数组为空，`memory.enabled` 为 `false`，尚未 ready，应继续使用完整替换接口配置。

## 读取与完整替换

`GET /api/v1/profiles/:profileId` 返回 Web 可编辑 Profile，不包含完整 runtime，但包含顶层 `gatewayAllowlist: string[]`。`PUT /api/v1/profiles/:profileId` 接收 `name`、`identity`、`gatewayAllowlist`、`ai`、`memory`、`platforms` 和 `acknowledgedWarnings`；这是可见字段的 replace，不是 patch。`identity` 与 `memory` 必须显式提供，未知字段会被拒绝。Server 只把 `gatewayAllowlist` 合并回隐藏的 `runtime.gatewayAllowlist`，其余 runtime 原样保留；若目标 Profile 没有 runtime，替换返回 `409 profile_runtime_missing`。

::: code-group

```json [最小 OpenAI-compatible 替换体 ~vscode-icons:file-type-json~]
{
  "name": "本地配置",
  "identity": {
    "name": "Kaguya",
    "aliases": ["辉夜"],
    "persona": "是人类，正在上网和群友聊天。回复自然、简短。"
  },
  "gatewayAllowlist": ["qq:group:778899", "qq:private:112233"],
  "ai": {
    "defaultProviderId": "default-provider",
    "modelTiers": {
      "light": {
        "providerId": "default-provider",
        "modelId": "model-light",
        "generation": {
          "reasoning": "minimal"
        },
        "recommendedDurationMs": 2000
      },
      "heavy": {
        "providerId": "default-provider",
        "modelId": "model-heavy",
        "generation": { "reasoning": "high" },
        "recommendedDurationMs": 8000
      }
    },
    "providers": [
      {
        "id": "default-provider",
        "type": "openai-compatible",
        "enabled": true,
        "baseUrl": "https://model.example/v1",
        "apiKey": "test-only-placeholder",
        "models": ["model-light", "model-heavy"],
        "settings": {}
      }
    ]
  },
  "memory": { "enabled": false },
  "platforms": [],
  "acknowledgedWarnings": []
}
```

:::

每个 tier 可选的 `generation` 使用与 provider 无关的稳定字段：
`reasoning` 使用 AI SDK 的统一取值：
`provider-default|none|minimal|low|medium|high|xhigh`。WebUI 的思考模式开关关闭时
保存 `none`；开启时使用选定的 effort。LLM 边界负责把该字段转换为 provider 调用参数；
模块不得直接写 provider 专用字段。若 provider 或模型不支持，具体告警或拒绝行为由
provider SDK/API 决定。tier 配置不设置 temperature 或 token 上限。

这里的 `reasoning` 是 Vercel AI SDK 7 的顶层统一调用参数。SDK 会由具体 Provider
adapter 转换为对应协议字段；例如 OpenAI-compatible adapter 会映射为
`reasoning_effort`。Anthropic 的 `providerOptions.anthropic.thinking` 属于 Provider
专属配置，并不是跨 Provider 的统一参数。生成请求始终由 Vercel AI SDK 发出。

`recommendedDurationMs` 是软延迟预算，只用于调度和观测参考，不会创建硬超时或
中断仍在生成的回复。建议 light 使用约 `2000ms`；heavy 通常使用
`3000..10000ms`（WebUI 新配置默认显示 `5000ms`）。真正需要硬超时时应由调用方的
取消信号或独立超时策略控制。

## 获取 Provider 模型列表

`POST /api/v1/models/discover` 使用当前表单中的 OpenAI-compatible 地址和 API Key
请求 Provider 的 `GET /models`。该操作不会保存凭据，也不会自动修改 light/heavy。

```json
{
  "baseUrl": "https://model.example/v1",
  "apiKey": "test-only-placeholder"
}
```

成功响应为 `{ "data": { "models": ["model-a", "model-b"] } }`。请求最多等待
10 秒，拒绝重定向及超过 1 MiB 的响应；Provider 错误正文和凭据不会返回给客户端。

替换 selected Profile 会返回 `restartRequired: true`。完整替换会以请求中的 acknowledgement 为准，不继承先前确认。

`memory.enabled` 只有在 Server 重启、selected Profile 重新装配 Runtime 后生效。关闭时不会注册内置 Memory retrieval strategy，也不会向模块暴露 Memory capability；association 仍以 `unavailable` 空结果完成，因此回复流程不会中断。

::: warning 示例凭据
文档、测试、Issue 和 PR 只使用无效占位值。不要把真实 API Key 粘贴到公开记录中。
:::

## 选择 Profile

`PUT /api/v1/profiles/selection` 把一个现有 Profile 设为全局 selected。选择变化后需要重启；接口不会替你启动、停止或热重载 Runtime。

::: code-group

```json [请求体 ~vscode-icons:file-type-json~]
{ "selectedProfileId": "generated-id" }
```

:::

## 删除 Profile

`DELETE /api/v1/profiles/:profileId` 成功返回 `204`。`default` 是保留 Profile，不能删除；selected Profile 也不能删除。应先选择另一个已就绪 Profile，重启验证后再删除旧项。

## 错误与并发边界

Profile ID 或正文不合法返回 `400`；目标不存在返回 `404`；保留项、selected 项或配置状态冲突返回 `409`；认证失败返回 `401`。错误使用统一结构并携带 requestId，格式见[HTTP API](./http-api)。

Profile Registry 没有跨进程写入协调。同一 `KAGUYA_CONFIG_ROOT` 只允许一个活动 Server 或管理写入者。
