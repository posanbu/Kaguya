---
title: 环境变量
description: Kaguya 启动时用于定位 Profile 的环境变量参考。
---

# 环境变量

Kaguya 的运行配置统一保存在 selected Profile。服务启动前只读取一个环境变量，用于定位配置根目录；端口、网关令牌、数据库、白名单、NapCat、日志和模型参数都不再从环境变量读取。

## Profile 定位

**`KAGUYA_CONFIG_ROOT`** — 可选。指定 Profile Registry 的绝对或相对路径；未设置时使用 `.data/kaguya-config`。目录、`index.json` 和全部 Profile JSON 都包含敏感配置，应限制运行账号访问。

启动时如果目录不存在、Registry 损坏、selected Profile 不完整或没有启用的外部平台，服务会输出用户可读的错误摘要并以非零状态退出。详细 issue 会通过 Pino 记录为 `configuration.validation.failed`，日志不会包含 API key、access token 或完整凭据。

## Profile 中的替代字段

以下参数必须写入 Profile 的 `runtime` 字段：

**监听与路径** — `host`、`port`、`databasePath`、`webDistPath`。

**网关安全** — `gatewayToken`、`gatewayAllowlist.platforms`、`gatewayAllowlist.userIds`、`gatewayAllowlist.groupIds`。

**HTTP 行为** — `corsOrigins`、`trustProxy`、`rateLimitMax`、`rateLimitWindowMs`。

**日志行为** — `logLevel` 和 `logFormat`。

NapCat 不再使用 `KAGUYA_NAPCAT_*` 变量，而是作为 `platforms` 中 `type: "napcat"` 的通用平台条目保存。其 `settings` 至少包含 `adapterId`、`wsUrl` 和 `reconnectMs`，访问令牌放在 `credentials.accessToken`。

## 已删除的环境变量接口

以下变量不会被读取、迁移或覆盖 Profile：

**服务参数** — `KAGUYA_HOST`、`KAGUYA_PORT`、`KAGUYA_DATABASE_PATH`、`KAGUYA_WEB_DIST_PATH`、`KAGUYA_CORS_ORIGINS`、`KAGUYA_TRUST_PROXY`、`KAGUYA_RATE_LIMIT_MAX`、`KAGUYA_RATE_LIMIT_WINDOW_MS`。

**白名单参数** — `KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS`、`KAGUYA_GATEWAY_ALLOWLIST_USER_IDS`、`KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS`。

**NapCat 参数** — `KAGUYA_NAPCAT_ENABLED`、`KAGUYA_NAPCAT_WS_URL`、`KAGUYA_NAPCAT_ACCESS_TOKEN`、`KAGUYA_NAPCAT_SELF_ID`、`KAGUYA_NAPCAT_RECONNECT_MS`。

**日志参数** — `KAGUYA_LOG_FORMAT`、`KAGUYA_LOG_LEVEL`、`KAGUYA_LOG_LEVELS`、`KAGUYA_LOG_ASYNC`、`KAGUYA_LOG_DESTINATION`。

**旧模型参数** — `KAGUYA_LLM_API_KEY`、`KAGUYA_LLM_BASE_URL`、`KAGUYA_LLM_MODEL`。
