---
title: 运行参数
description: 配置目录、端口、数据库、日志、限流与远程访问。
---

# 运行参数

端口、数据库和日志等设置在所选 Profile 文件的 `runtime` 中，网页不直接编辑这些字段。默认文件为 `.data/kaguya-config/profiles/profile_default.json`；其他方案请按配置目录 `index.json` 中的 `selectedProfileId` 找到对应文件。

手工修改前停止服务并备份，修改后重新启动。以下默认值来自新建的开发配置。

## 配置目录

**`KAGUYA_CONFIG_ROOT`** — 可选环境变量，默认使用仓库的 `.data/kaguya-config`。换目录时先复制现有配置；指向空目录不会自动找到旧配置。

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
$env:KAGUYA_CONFIG_ROOT = "C:\kaguya\config"
pnpm dev
```

```bash [macOS / Linux ~vscode-icons:file-type-shell~]
export KAGUYA_CONFIG_ROOT="/srv/kaguya/config"
pnpm dev
```

:::

模型、数据库、端口和平台凭据通过 Profile 配置，不通过环境变量覆盖。

## 端口与网页

**`host`** — 默认 `127.0.0.1`。只接受 `127.0.0.1`、`localhost` 或 `::1`，不能改为 `0.0.0.0`。

**`port`** — 默认 `3000`，范围 `1–65535`。端口被占用时可改成其他空闲端口，重启后以新打印的访问链接为准。

**`webDistPath`** — 生产网页的构建目录，默认指向 `apps/web/dist`。通常无需修改；缺少产物时先执行 `pnpm build`。

**`corsOrigins`** — 允许的跨域网页来源，默认 `[]`。使用自带同源网页时保持默认；单独部署客户端时才添加明确的来源地址。

**`trustProxy`** — 默认 `false`。接入可信反向代理时可填代理地址数组，影响客户端地址识别；普通本地使用不需修改。

## 数据库

**`databaseMode`** — 默认 `managed`，开发命令管理本地固定容器。使用自己部署的数据库时改为 `external`，命令只连接数据库，不管理 Docker。

**`databaseUrl`** — PostgreSQL 17 连接地址，包含用户名、密码、主机、端口和数据库名。本地托管模式会写入对应地址。

接入外部数据库时，在现有 `runtime` 对象中修改这两个字段，其余字段保持完整：

::: code-group

```json [需要替换的字段 ~vscode-icons:file-type-json~]
{
  "databaseMode": "external",
  "databaseUrl": "postgresql://kaguya:REPLACE_PASSWORD@127.0.0.1:5432/kaguya"
}
```

:::

这是字段片段，不能替换整个 Profile 或整个 `runtime`。请先准备 PostgreSQL 17 数据库及具备建表权限的账号，再重启 Kaguya。连接新数据库不会自动迁移原有聊天记录。

### 管理本地托管数据库

::: code-group

```bash [状态与检查 ~vscode-icons:file-type-shell~]
pnpm postgres:status
pnpm postgres:start
pnpm postgres:check
```

:::

`status` 查看状态，`start` 创建或恢复数据库，`check` 检查连接、版本与结构。容器名为 `kaguya-postgres-17`，数据卷名为 `kaguya-postgres-17-data`。

首次创建需要换数据库端口时，可用 `pnpm postgres:start -- --port 55432`。已有容器不会因端口不匹配而自动重建；不要删除数据卷来处理端口问题。

## 日志与限流

**`logLevel`** — 默认 `info`。可选 `trace`、`debug`、`info`、`warn`、`error`、`fatal`、`silent`；排查时可临时改为 `debug`，正常运行恢复 `info`。

**`logFormat`** — 开发配置默认 `pretty`，适合终端阅读；`json` 适合日志收集工具。

**`rateLimitMax`** — 每个限流窗口允许的请求次数，默认 `30`，范围 `1–10000`。

**`rateLimitWindowMs`** — 窗口长度，默认 `60000`（60 秒），范围 `1000–3600000`。超过限制会返回 `429`。

**`inboundAllowlist` / `outboundAllowlist`** — 非 Web 平台的双向消息规则，默认都是空数组。可以在网页编辑，格式见[QQ 白名单](./napcat#允许哪些群和私聊)。

## 远程访问

服务只监听本机地址。部署在远程服务器时，可以通过 SSH 转发端口：

::: code-group

```bash [在本机终端运行 ~vscode-icons:file-type-shell~]
ssh -N -L 13000:127.0.0.1:3000 USER@SERVER
```

:::

把服务器本次打印的访问链接中的主机和端口替换为 `127.0.0.1:13000`，保留原有 `#gatewayToken=...`，在本机浏览器打开。保持转发终端运行；如服务器使用其他端口，同步修改命令。
