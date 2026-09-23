---
title: 常见问题
description: 排查页面无法打开、配置未生效、模型和 QQ 不回复等问题。
---

# 常见问题

按实际现象检查。报告问题时提供复现步骤和错误信息，删除访问令牌、API Key、数据库密码及私人消息内容。

## 页面打不开

确认启动终端仍在运行，地址与终端打印的一致。默认端口的健康检查：

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
Invoke-RestMethod http://127.0.0.1:3000/healthz
```

```bash [macOS / Linux ~vscode-icons:file-type-shell~]
curl http://127.0.0.1:3000/healthz
```

:::

正常应返回 `{"status":"ok"}`。没有响应时，检查终端启动错误、端口占用、Node.js/pnpm 版本；使用本地数据库时运行 `pnpm postgres:status` 并确认 Docker 已启动。生产模式缺少网页文件时执行 `pnpm build` 后重新启动。

若日志提示 schema metadata 缺失、版本不是 1、缺少 `attention-observation.v1` 协议标记、存在旧 `kaguya_schema_migrations` 或所需对象不完整，Server 会在监听 HTTP、Runtime 和 Adapter 前终止；该破坏式升级不会自动修复旧数据库。

## 提示访问受限或 401

每次重启都生成新令牌。打开当前终端打印的完整 `Kaguya access URL`，不要继续刷新旧链接。完整链接必须包含 `#gatewayToken=...`。

## 配置保存了，但没有变化

到“配置生效管理”确认目标 Profile 已设为当前，并点击“应用当前配置”。顶栏切换查看对象和保存文件都不会自动应用。

**无效配置 `invalid`** — 修正页面列出的字段。

**需要确认 `review_required`** — 阅读并处理当前配置的警告。

**需要重启 `restart_required`** — 停止服务，再以原命令启动，并打开新链接。

名称、人设和其他 Prompt 修改需要重启。更多说明见[配置概览](./configuration)。

## 机器人不回复

1. 在“Gateway / Adapter”确认 Runtime 可用；网页能打开不代表模型已经就绪。
2. 确认模型地址、密钥、模型 ID 正确，且保存后已应用。
3. QQ 场景检查 NapCat 已连接，以及目标同时满足入站和出站白名单。
4. 检查唤醒/休眠状态、静默模式和 Planner 等待设置。机器人可能仍在休眠积攒通知，或决定不参与当前对话。
5. 在检查页面或日志中确认是否有模型超时、供应商错误或投递失败。

Web 私聊支持显示回复，并在刷新后恢复当前会话记录。接口的 `202 accepted` 只是收到消息，回复还需要等待后续处理完成。

## 模型超时或参数报错

核对供应商模型支持的思考参数；不确定时恢复供应商默认。模型超时默认 300 秒，可在配置页分层设置。建议耗时只记录期望，不会中断请求。连接参数见[模型配置](./models)。

供应商拒绝密钥时，需要检查该服务的密钥或账号状态，反复重启 Kaguya 无法修复被禁用的凭据。

## QQ 连接失败

检查 NapCat 已登录，开启的是正向 WebSocket，Kaguya 填写的地址可达且 access token 一致。`selfId` 如有填写，必须是机器人自己的 QQ 号。详细步骤见[接入 QQ](./napcat)。

## 返回 429、413 或 415

**`429`** — 超过限流，默认每 60 秒 30 次，稍后再试。

**`413`** — 请求体超过 256 KiB，缩短消息。

**`415`** — 请求格式不支持。自建客户端提交消息时使用 `application/json`。

## 配置文件或数据库校验失败

先备份，再根据日志修复对应字段。JSON 损坏、旧结构或缺少模块都可能阻止启动；处理方法见[更新与备份](./maintenance)。

配置目录不能是越界路径或不允许的符号链接。POSIX 目录和文件分别使用 `0700`、`0600` 权限；Windows 使用受限的 NTFS ACL。同一配置目录不要同时运行两个 Kaguya 服务。

数据库需要 PostgreSQL 17；旧结构、版本错误或表结构不完整不会被自动忽略。保留数据，核对版本要求后处理。
