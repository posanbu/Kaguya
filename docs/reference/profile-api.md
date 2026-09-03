---
title: Profile API
description: Kaguya Profile Registry 的读取、创建、完整替换、选择与删除契约。
---

# Profile API

所有 Profile 路由都需要当前实例的 Bearer Token。`GET /api/v1/setup` 只返回无 secret 的 readiness 和 Profile 摘要；读取单个 Profile 会返回 API Key 等敏感字段，只能在可信边界内调用。

## 列出 Profile

`GET /api/v1/profiles` 返回全局 `selectedProfileId` 和 metadata 列表。metadata 用于导航，不包含完整 Provider 凭据。

::: code-group

```bash [请求 ~vscode-icons:file-type-shell~]
curl http://127.0.0.1:3000/api/v1/profiles \
  -H "Authorization: Bearer replace-with-current-token"
```

```json [响应形状 ~vscode-icons:file-type-json~]
{
  "data": {
    "selectedProfileId": "default",
    "profiles": [
      {
        "id": "default",
        "name": "default",
        "createdAt": "2026-09-03T00:00:00.000Z",
        "updatedAt": "2026-09-03T00:00:00.000Z"
      }
    ]
  }
}
```

:::

## 创建 Profile

`POST /api/v1/profiles` 只接收 `name`，创建未选中的空 Profile并返回 `201`。它不会复制当前 Profile，也不会让 Runtime 自动切换。

::: code-group

```json [请求体 ~vscode-icons:file-type-json~]
{ "name": "实验模型" }
```

:::

响应返回完整 `profile` 和 `restartRequired`。空 Profile 的 Provider、平台和插件数组为空，尚未 ready，应继续使用完整替换接口配置。

## 读取与完整替换

`GET /api/v1/profiles/:profileId` 返回完整 Profile。`PUT /api/v1/profiles/:profileId` 要求提供 `name`、`ai`、`platforms`、`plugins` 和 `acknowledgedWarnings` 全部字段；这是 replace，不是 patch，省略字段不会保留旧值。

::: code-group

```json [最小 OpenAI-compatible 替换体 ~vscode-icons:file-type-json~]
{
  "name": "本地配置",
  "ai": {
    "defaultProviderId": "default-provider",
    "modelTiers": {
      "light": { "providerId": "default-provider", "modelId": "model-light" },
      "heavy": { "providerId": "default-provider", "modelId": "model-heavy" }
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
  "platforms": [],
  "plugins": [],
  "acknowledgedWarnings": ["platforms-empty", "plugins-empty"]
}
```

:::

替换 selected Profile 会返回 `restartRequired: true`。完整替换会以请求中的 acknowledgement 为准，不继承先前确认。

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
