---
title: 使用 Web UI
description: 使用同源 Web UI 管理全局 Profile 并提交消息。
---

# 使用 Web UI

`apps/web` 是 React/Vite 客户端，由统一 Kaguya Server 同源提供。页面、健康检查和 API 默认都位于 `http://127.0.0.1:3000`，无需配置第二个 Web 服务地址。

## 打开页面

先按[安装与启动](./installation)运行 Server，然后在浏览器打开：

::: code-group

```text [默认地址 ~vscode-icons:file-type-url~]
http://127.0.0.1:3000
```

:::

开发模式的 HMR 与 API 共用该端口；生产模式由 Fastify 提供 `apps/web/dist`。

## 管理全局 Profile

Profile Registry 维护一组 Profile metadata 与唯一的 `selectedProfileId`。Web UI 通过受保护的 Profile API 创建、读取、完整替换、显式选择和删除 Profile；只有选中的 Profile 会在下一次 Server 启动时用于构造 Runtime 的模型解析器。

当选中的 Profile 尚未就绪时，首页显示配置引导而不是消息界面。引导可设置 OpenAI-compatible Provider 的 Base URL、API Key、light/heavy 模型与可选配置确认。API Key 只经受保护接口提交，不写入浏览器存储。

选择 Profile，或替换当前选中的 Profile 后，页面会显示需要重启的状态；重启 Server 并刷新页面后，新选择才会进入 Runtime。系统不会按消息、模块或用户回退到其他 Profile、Provider 或模型。

## Gateway Token

Gateway Token 用于调用受保护的配置和消息接口。显式设置 `KAGUYA_GATEWAY_TOKEN` 时使用该值；全新本地配置且仅监听 loopback 时，Server 会在终端展示一次性 bootstrap Token。首次配置成功后，页面取得正式 Token，bootstrap Token 随即失效。

Token 不写入任何浏览器存储，也不应放进 `VITE_*` 环境变量；这类变量会进入前端构建产物。正式 Token 不通过普通 readiness 接口公开返回。

## 当前交互能力

**健康检查** — 页面检测统一 Server 是否可用。

**Profile 管理** — 展示当前 `selectedProfileId` 与 Profile metadata，并完成创建、读取、替换、选择和删除。

**输入校验** — 发送前检查 Token、空消息和消息长度。

**提交状态** — 展示提交中、Server 已接受或提交失败。

**结构化错误** — 显示 API 返回的错误码与 request ID，便于结合日志排查。

**响应式布局** — 支持桌面与移动视口。

**NapCat 配置** — 在 Profile 管理页点击“NapCat 配置”，可以填写启用状态、反向 WebSocket 地址、Access Token、机器人 QQ 号和重连间隔。保存后配置写入 `KAGUYA_CONFIG_ROOT/napcat.json`，重启 Kaguya 才会创建连接；已保存的 Access Token 只显示为“已保存”，不会通过读取接口返回原文。

Provider 配置不再要求确认“平台与插件稍后配置”。平台和插件可以保持为空，NapCat 则在独立页面中按需配置。

## 当前消息响应边界

`POST /api/v1/messages` 返回 `202 accepted`，仅表示 HTTP Server 已接收文本并开始异步提交给 Web ingress；它不表示入站原子已持久化、LLM 已完成或平台已投递。异步提交失败会被网关安全记录，响应不会伪造机器人回答。

当前没有回复查询或 SSE。默认模块可形成 assistant 与投递请求原子，但 Web 入站的默认目标是 Web，且没有注册 Web transport；要向平台投递，需要启用并成功连接相应 adapter。

## 常见问题

### 页面打不开

确认 `pnpm dev` 仍在运行，并检查终端是否出现 `server.start.failed` 或 Vite 启动错误。

### 返回 401

显式环境 Token 不会自动显示。首次配置应使用 Server 终端展示的一次性 bootstrap Token；成功后页面会取得正式 Token。如果页面刷新后丢失 Token，请重新输入显式环境 Token，或使用首次配置成功时返回的正式 Token。

### 配置保存后仍显示引导页

保存或选择 Profile 后必须重启 Server，再刷新浏览器。Runtime 只在启动时读取全局 `selectedProfileId`。

### Web UI 正常但 NapCat 无响应

筛选 `module=adapter:napcat` 的日志。NapCat 连接失败不会停止 HTTP 与 Web UI。

### 页面显示 accepted 但没有回答

这是当前协议的预期行为。`202` 不是模型或投递回执，Web API 也没有回复读取通道。
