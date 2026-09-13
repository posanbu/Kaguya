---
title: 环境变量与运行配置
description: selected Profile、开发 PostgreSQL 与仅保留环境变量的参考。
---

# 环境变量与运行配置

Kaguya 的持久运行配置以 selected Profile 为唯一真值。应用环境只用于定位 Profile Registry；数据库、监听、Web、CORS、代理、限流、日志、allowlist、AI、Memory、平台和插件都不再从环境变量读取。

## 应用环境

**`KAGUYA_CONFIG_ROOT`** — 可选，默认 `.data/kaguya-config`。它只指定权限受保护的 Profile Registry 根目录，不覆盖 Profile 内的任何值。

**`NODE_ENV`** — 由启动脚本设置为 `development` 或 `production`，只选择 Vite 开发资源或已构建的静态资源，不承载持久运行配置。

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
$env:KAGUYA_CONFIG_ROOT = "C:\\kaguya\\config"
pnpm dev
```

```bash [POSIX shell ~vscode-icons:file-type-shell~]
export KAGUYA_CONFIG_ROOT="/srv/kaguya/config"
pnpm dev
```

:::

## selected Profile runtime

`runtime` 是 Profile JSON 中的隐藏管理字段。Web Profile API 不返回或接收完整 runtime；它只把 `inboundAllowlist` 和 `outboundAllowlist` 安全投影为 Profile 顶层字段，保存时仅合并回这两个 runtime 字段。数据库 URL、CORS、日志等其他 runtime 内容保持隐藏且原样保留。新建 Profile 继承当时 selected Profile 的 runtime。

**`databaseMode`** — 必填，值为 `managed` 或 `external`。

**`databaseUrl`** — PostgreSQL 连接 URL。外部数据库只通过 Profile 文件配置；Server 与 demo 都从 selected Profile 读取。

**`host` / `port`** — Server 监听地址和端口。host 只允许 `127.0.0.1`、`localhost` 或 `::1`。

**`webDistPath` / `corsOrigins` / `trustProxy`** — Web 静态资源、CORS 和可信代理配置。

**`rateLimitMax` / `rateLimitWindowMs`** — HTTP 限流次数与窗口。

**`logLevel` / `logFormat`** — 日志级别以及 `json` 或 `pretty` 格式。

**`inboundAllowlist` 与 `outboundAllowlist`** — 字符串规则数组，每条格式为 `platform:chat_type:target_id`。`chat_type` 只接受 `group` 或 `private`；群聊用 `groupId`，私聊用 `userId`。规则按 OR 匹配，`platform` 和 `target_id` 支持 `*`，比较保持大小写敏感。每个空数组只拒绝对应方向的非 Web 消息；全部放行需要同时配置 `*:group:*` 和 `*:private:*`。解析会修剪三段，格式错误、空段、未知 chat type 或额外冒号的规则静默忽略。Web 入口仍只由 Gateway Token 控制，群规则不会限制群成员。

入站列表只决定外部消息是否进入 Runtime；拒绝时不会创建 turn。出站列表用于目标授权和最终投递检查，拒绝时不调用 transport，记录 `destination-not-allowed` 安全错误码。两套权限互不继承，可配置只接收或只发送；跨会话发送仍需管理端确认。

旧版 `runtime.gatewayAllowlist` 不再接受，读取、启动及 API 保存均不会自动转换或覆盖配置文件。升级前备份配置目录，手动删除旧字段，并显式填写 `runtime.inboundAllowlist` 与 `runtime.outboundAllowlist` 两个数组。若要保持旧版双向使用同一规则的行为，可将旧数组复制到两个新字段；如需单向权限，分别编辑。缺少任一方向或同时保留旧字段都会校验失败。首次升级需重启以读取有效配置；之后保存或选择 Profile 仍只写盘，两套策略都在点击“应用当前配置”后切换。

::: code-group

```json [外部 PostgreSQL runtime ~vscode-icons:file-type-json~]
{
  "runtime": {
    "host": "127.0.0.1",
    "port": 3000,
    "databaseMode": "external",
    "databaseUrl": "postgresql://kaguya:replace-me@127.0.0.1:5432/kaguya",
    "webDistPath": "apps/web/dist",
    "corsOrigins": [],
    "trustProxy": false,
    "rateLimitMax": 30,
    "rateLimitWindowMs": 60000,
    "logLevel": "info",
    "logFormat": "json",
    "inboundAllowlist": ["qq:group:REPLACE_GROUP_ID"],
    "outboundAllowlist": ["qq:private:REPLACE_USER_ID"]
  }
}
```

:::

示例只是 Profile 的局部形状，不能直接替换完整 Profile 文件。配置目录和数据库 URL 都按敏感数据保护。

## Gateway Token

Gateway Token 不属于持久配置，也不是 Profile runtime 的合法字段。Server 每次启动用安全随机数生成新 token，只保存在当前进程和成功监听后打印的 `Kaguya access URL` fragment 中。重启后必须使用新链接。

## NapCat

NapCat 页面直接读写 selected Profile 的 `platforms` 条目。启用项的 `settings` 保存 adapter ID、WebSocket URL、self ID 与重连间隔，`credentials` 保存可选 access token。NapCat 断线重连不等于信息消费者或投递自动重试。

## 测试专用 PostgreSQL

**`KAGUYA_TEST_DATABASE_URL`** — 只供 CI 的 `pnpm test:postgres` 子进程使用。显式提供时，命令绕过 Docker 和 Profile，只检查目标 PostgreSQL 17；普通 Server 和 demo 不读取它。

本地不要设置此变量。`pnpm test:postgres` 会自动复用 `kaguya-postgres-17`，并把测试 URL 只注入 Vitest 子进程。各 suite 创建随机 `kaguya_test_*` schema，结束时只清理自己的 schema，不清空应用 schema、容器或数据卷。
