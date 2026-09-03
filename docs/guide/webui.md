---
title: 使用 Web UI
description: 使用同源 Web UI 完成首次配置并提交消息。
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

## 首次配置页面

当默认 profile 尚未就绪时，首页显示配置引导，而不是消息界面。引导页会收集 OpenAI-compatible Provider 的 Base URL、API Key、light/heavy 模型 ID。

API Key 只通过受保护的配置接口提交，不写入浏览器存储。保存完成后，页面会提示重启 Server；重启并刷新页面后才能进入正常消息界面。

## Gateway Token

Gateway Token 用于调用受保护的配置和消息接口。它由 Server 在启动时确定：未设置 `KAGUYA_GATEWAY_TOKEN` 时自动生成随机 token（日志 `server.token.generated`），页面加载时自动获取，无需手填。

Token 不写入任何浏览器存储，也不应放进 `VITE_*` 环境变量（这类变量会进入前端构建产物）；它每次页面加载时从 Server 重新获取。

## 当前交互能力

**健康检查** — 页面检测统一 Server 是否可用。

**输入校验** — 发送前检查 Token、空消息和消息长度。

**提交状态** — 展示提交中、Server 已接受或提交失败。

**结构化错误** — 显示 API 返回的错误码与 requestId，便于结合日志排查。

**响应式布局** — 支持桌面与移动视口。

**NapCat 配置** — 在 Profile 管理页点击“NapCat 配置”，可以填写启用状态、反向 WebSocket 地址、Access Token、机器人 QQ 号和重连间隔。保存后配置写入 `KAGUYA_CONFIG_ROOT/napcat.json`，重启 Kaguya 才会创建连接；已保存的 Access Token 只显示为“已保存”，不会通过读取接口返回原文。

Provider 配置不再要求确认“平台与插件稍后配置”。平台和插件可以保持为空，NapCat 则在独立页面中按需配置。

## 当前响应边界

`POST /api/v1/messages` 成功时返回 `202 accepted`，只表示 Runtime 已完成本次 dispatch。当前没有回复查询或 SSE，因此页面不会伪造机器人回答。

默认模块会持久化确定性回复，但 Web 入站没有默认 transport destination。只有平台消息携带 reply sender 时，演示模块链才会请求向平台投递。

## 常见问题

### 页面打不开

确认 `pnpm dev` 仍在运行，并检查终端是否出现 `server.start.failed` 或 Vite 启动错误。

### 返回 401

Token 由 Server 分发并在页面加载时自动获取。未显式设置 `KAGUYA_GATEWAY_TOKEN` 时，Server 重启后生成的 token 会变化，刷新页面重新获取即可。

### 配置保存后仍显示引导页

保存配置后必须重启 Server，再刷新浏览器。Runtime 不会在运行中热加载 Provider。

### Web UI 正常但 NapCat 无响应

筛选 `module=adapter:napcat` 的日志。NapCat 连接失败不会停止 HTTP 与 Web UI。

### 页面显示 accepted 但没有回答

这是当前协议的预期行为。Web API 没有回复读取通道；如需平台回复，需要启用并成功连接对应 adapter。
