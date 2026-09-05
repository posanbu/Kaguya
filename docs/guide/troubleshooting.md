---
title: 故障排查
description: 根据页面现象、HTTP 状态与日志快速定位 Kaguya 常见问题。
---

# 故障排查

先保留出错终端中的 `event`、requestId 和 traceId，不要公开 API Key、Authorization、消息正文或整个 `.data/` 目录。

## 页面完全打不开

确认 `pnpm dev` 仍在运行，然后检查健康接口：

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
Invoke-RestMethod http://127.0.0.1:3000/healthz
```

```bash [curl ~vscode-icons:file-type-shell~]
curl http://127.0.0.1:3000/healthz
```

:::

若没有 `{"status":"ok"}`，检查端口占用、`server.start.failed`、Node/pnpm 版本和生产模式下是否已经执行 `pnpm build`。若健康接口正常而页面失败，检查浏览器请求和 Web 静态产物。

## 一直停在配置页面

查看 `/api/v1/setup` 返回的 status。`invalid` 表示必填内容有问题；`review_required` 表示仍有警告未确认；`restart_required` 表示配置已保存但进程尚未重启。

不要通过手工修改 Registry 来绕过页面。先在 Web UI 修正字段，保存后停止并重新启动 Server。

## 重启后出现 401

若没有显式设置 `KAGUYA_GATEWAY_TOKEN`，每次启动都会生成新 token。刷新整个页面，让客户端重新请求 `/api/v1/setup`。外部脚本需要重新获取 token，或使用至少 16 字符的稳定环境变量。

## 配置目录无法打开

权限不安全、符号链接、路径越界、损坏 JSON 或旧版 v1/v2 Registry 都会被拒绝。先备份目录，再根据错误码修复权限或重新建立 v3 配置；当前没有自动迁移。

同一 `KAGUYA_CONFIG_ROOT` 不要同时交给两个 Server 或配置写入进程。Windows 生产环境需确认 NTFS ACL，POSIX 目录和文件分别使用 `0700` 与 `0600`。

## 消息显示 accepted，但没有回复

这是当前接口定义：202 只表示 Web gateway 接受消息，Runtime 在后台处理。Web UI 没有回复查询或 SSE；默认 Web 入站也没有可用的 outbound destination。通过 `web:${requestId}` 在日志中追踪，或使用已经注册 transport 的平台验证投递。

## 返回 429、413 或 415

**429** — 超过当前来源的限流窗口；默认每 60 秒 30 次。

**413** — 整个请求体超过 256 KiB。

**415** — Content-Type 不受支持；消息接口使用 `application/json`。

文本本身最多 131072 个 Unicode code point，且 trim 后不能只剩空白。

## Web UI 正常但 NapCat 失败

确认 `KAGUYA_NAPCAT_ENABLED=true`，并检查 WebSocket URL、访问凭据和 self ID。NapCat 连接失败不会停止 HTTP 与 Web UI；查看 `module=adapter:napcat` 的结构化日志。

## 文档站本地与线上不一致

本地热更新预览与 GitHub Pages 必须使用同一分支内容。先执行生产构建；随后通过 `/Kaguya/` 基础路径预览，而不是只检查开发首页。线上仍旧时，确认 PR 已合并、Pages workflow 使用最新 main，并清除浏览器缓存。

::: code-group

```bash [生产预览 ~vscode-icons:file-type-shell~]
cd docs
pnpm --ignore-workspace docs:build
pnpm --ignore-workspace docs:preview
```

:::

## 报告问题时提供什么

提供复现步骤、预期行为、实际行为、操作系统、`node --version`、`pnpm --version`、相关日志事件和 requestId。密钥、Token、消息内容和完整配置文件必须删除或替换为占位值。
