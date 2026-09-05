---
title: 环境变量
description: Kaguya Server、PostgreSQL、白名单、NapCat 与日志环境变量参考。
---

# 环境变量

除 `KAGUYA_TEST_DATABASE_URL` 仅由测试命令读取外，下列环境变量由 `apps/server` 在启动时读取。Provider Key、Base URL 和模型 ID 不属于环境变量，统一存放在 `KAGUYA_CONFIG_ROOT` 指向的 Profile Registry；Runtime 只使用启动时全局选中的 `selectedProfileId`。

## Server 与 PostgreSQL

**`KAGUYA_DATABASE_URL`** — 必填。非空 PostgreSQL 连接 URL，供 information ledger 使用。Server 不在普通日志、启动错误或失败事实中回显该 URL。

**`KAGUYA_HOST`** — 默认 `127.0.0.1`。只接受 `127.0.0.1`、`localhost` 或 `::1`；其他值会拒绝启动。

**`KAGUYA_PORT`** — 默认 `3000`，允许范围 1 至 65535。

## 测试专用 PostgreSQL

**`KAGUYA_TEST_DATABASE_URL`** — 仅供 `pnpm test:postgres` 连接真实 PostgreSQL，运行共享账本契约、索引与重连测试。CI 为它创建临时服务；`apps/server` 不读取此变量，生产环境必须配置 `KAGUYA_DATABASE_URL`。

## Server

**`KAGUYA_CONFIG_ROOT`** — 默认 `.data/kaguya-config`。权限受保护的 Profile Registry 根目录。

**`KAGUYA_WEB_DIST_PATH`** — 默认 `apps/web/dist`。生产静态产物目录，主要供测试和部署覆盖。

**`KAGUYA_CORS_ORIGINS`** — 默认空。逗号分隔的允许来源；空值关闭跨源许可，同源 Web UI 不受影响。

**`KAGUYA_TRUST_PROXY`** — 默认空。逗号分隔的可信代理地址或 CIDR；空值不信任转发地址。

**`KAGUYA_RATE_LIMIT_MAX`** — 默认 `30`，允许范围 1 至 10000。每个窗口的请求数。

**`KAGUYA_RATE_LIMIT_WINDOW_MS`** — 默认 `60000`，允许范围 1000 至 3600000 毫秒。

::: warning 使用终端中的完整访问链接
Server 每次成功监听后生成并打印带 `#gatewayToken=` fragment 的访问链接。该 token 对 setup、Profile、NapCat 和消息接口均有效，只在当前进程生命周期内有效；重启后需要重新打开新链接。
:::

## 平台入站白名单

**`KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS`** — 逗号分隔的平台 ID；空值表示不限制平台。

**`KAGUYA_GATEWAY_ALLOWLIST_USER_IDS`** — 逗号分隔的用户 ID；空值表示不限制用户。

**`KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS`** — 逗号分隔的群组 ID；空值表示不限制群组。

只要某一维度配置了值，入站消息对应字段就必须命中；多个维度同时配置时需要全部满足。检查发生在 adapter 向 Runtime 提交内容之前，因此未命中的内容不会生成信息原子或触发模块。

::: code-group

```dotenv [只允许指定群组 ~vscode-icons:file-type-dotenv~]
KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS=123,456
```

:::

## NapCat

**`KAGUYA_NAPCAT_ENABLED`** — 默认 `false`。设为 `true` 时启动 WebSocket supervisor。

**`KAGUYA_NAPCAT_WS_URL`** — 启用 NapCat 时必填。完整地址不得写入普通日志。

**`KAGUYA_NAPCAT_ACCESS_TOKEN`** — 可选连接凭据。

**`KAGUYA_NAPCAT_SELF_ID`** — 可选，用于校验事件中的机器人 ID。

**`KAGUYA_NAPCAT_RECONNECT_MS`** — 默认 `3000`，允许范围 100 至 3600000 毫秒。它只控制 NapCat 连接 supervisor 的重连间隔，不是信息消费者或投递的自动重试。

NapCat 断线会按连接配置重连，不会停止 Fastify 或改变健康检查。一次已经注册的投递请求仍只产生相应成功或失败事实，Core 不会将其放入工作队列或自动重试。

## 日志

**`NODE_ENV`** — `development` 时默认 pretty 日志；其他环境默认 JSON。

**`KAGUYA_LOG_FORMAT`** — `pretty` 或 `json`，显式覆盖环境默认值。

**`KAGUYA_LOG_LEVEL`** — 默认 `info`，可用 `trace`、`debug`、`info`、`warn`、`error`、`fatal` 或 `silent`。

**`KAGUYA_LOG_LEVELS`** — 逗号分隔的 `namespace=level`，最长命名空间前缀优先。

**`KAGUYA_LOG_ASYNC`** — 默认 `false`；仅 JSON 支持异步 worker transport。

**`KAGUYA_LOG_DESTINATION`** — 默认 `stdout`。pretty 只支持 `stdout` 或 `stderr`；JSON 还可使用文件路径。

::: code-group

```dotenv [开发调试 ~vscode-icons:file-type-dotenv~]
KAGUYA_LOG_LEVEL=info
KAGUYA_LOG_LEVELS=runtime=debug
```

```dotenv [生产 JSON 文件 ~vscode-icons:file-type-dotenv~]
NODE_ENV=production
KAGUYA_LOG_FORMAT=json
KAGUYA_LOG_ASYNC=true
KAGUYA_LOG_DESTINATION=.data/logs/kaguya.jsonl
```

:::

## 已废弃并拒绝的变量

检测到以下任一变量时，Server 会在启动前失败，不读取其值，也不自动迁移：

**旧多应用变量** — `KAGUYA_API_HOST`、`KAGUYA_API_PORT`、`KAGUYA_API_DATABASE_PATH`、`KAGUYA_BOT_DATABASE_PATH`。

**旧模型变量** — `KAGUYA_LLM_API_KEY`、`KAGUYA_LLM_BASE_URL`、`KAGUYA_LLM_MODEL`。

模型配置应迁移到 profile store；Server 地址和数据库应使用统一变量。
