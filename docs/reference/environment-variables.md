---
title: 环境变量与运行配置
description: 查找服务器运行参数和测试环境变量。
---

# 环境变量与运行配置

安装、端口、数据库、日志和远程访问的操作说明统一放在[运行参数](../guide/runtime)，日常使用从那里查阅。

## 应用环境

**`KAGUYA_CONFIG_ROOT`** — 定位配置根目录，默认仓库的 `.data/kaguya-config`。不覆盖 Profile 内的值。

**`NODE_ENV`** — 由启动脚本选择开发或生产资源，不承载持久配置。

## Profile 中的运行参数

完整 `runtime` 只在 Profile 文件中维护。Web Profile API 只投影和更新 `inboundAllowlist`、`outboundAllowlist`；其他运行参数保持隐藏。新建 Profile 继承当前所选方案的 runtime。

字段用途和默认值见[运行参数](../guide/runtime)，双向规则见[QQ 白名单](../guide/napcat#允许哪些群和私聊)。旧 `gatewayAllowlist` 的处理见[更新与备份](../guide/maintenance#旧配置导致启动失败)。

Gateway Token 每次启动随机生成，不属于 Profile，也不能通过环境变量固定。

## 测试专用

**`KAGUYA_TEST_DATABASE_URL`** — CI 的 `pnpm test:postgres` 使用。显式提供时绕过 Docker 和 Profile，只检查目标 PostgreSQL 17；普通 Server 不读取它。

本地 `pnpm test:postgres` 自动复用托管实例，向测试子进程注入连接地址。测试使用独立的随机 schema，结束时只清理自己的 schema。
