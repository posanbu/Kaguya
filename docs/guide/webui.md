---
title: 使用 Web UI
description: 通过同源 Web UI 管理 Profile、提交消息并理解当前响应边界。
---

# 使用 Web UI

`apps/web` 是 React/Vite 客户端，由统一 Kaguya Server 同源提供。页面、健康检查和 API 默认都位于 `http://127.0.0.1:3000`，不需要再启动一个 Web 服务。

## 打开页面

先按[安装与启动](./installation)运行 Server，再打开：

::: code-group

```text [默认地址 ~vscode-icons:file-type-url~]
http://127.0.0.1:3000
```

:::

开发模式把 Vite middleware 与热更新挂在 Fastify 内；生产模式由 Fastify 提供 `apps/web/dist`。

## 页面如何决定显示内容

页面加载时先请求 `/api/v1/setup`，取得 readiness、Profile 摘要和本实例 Gateway Token。随后进入以下状态之一：

**检查中** — 等待 Server 返回配置状态。

**Profile 管理** — 所选配置无效或仍需确认；可以创建、编辑、选择和删除 Profile。

**等待重启** — 新的所选配置已经写盘，但 Runtime 仍需重启才能采用。

**消息界面** — 配置为 ready，可以提交文本。

**错误** — 服务不可达或请求失败；页面给出错误并允许重新加载。

界面状态和设计约束见[配置流程设计](../design/configuration-flow)。

## Gateway Token 与访问边界

Gateway Token 保护 Profile 和消息接口。未设置 `KAGUYA_GATEWAY_TOKEN` 时，Server 每次启动生成随机 token；Web UI 从 `/api/v1/setup` 或 `/api/v1/gateway/token` 自动取得，不要求手填，也不写入浏览器持久存储。

这两个取 token 的接口本身是公开的。因此，**任何能访问 Kaguya 监听端口的人，实际上都能取得管理与消息权限**。默认只监听 `127.0.0.1`；不要仅靠这个 token 把服务直接暴露到公网。需要远程访问时，应放在可信网络或具备 TLS 与独立认证的反向代理之后。

## 管理 Profile

进入 Profile 管理后，先在列表中选择要编辑的 Profile，再填写名称、Base URL、API Key、light model 与 heavy model。保存 selected Profile 或切换 selected Profile 后，按页面提示重启 Server。

`default` Profile 不能删除；当前 selected Profile 也不能删除。创建新 Profile 不会自动选中或改变正在运行的 Runtime。字段含义与操作顺序见[配置 Kaguya](./configuration)。

## 提交消息

消息界面目前只接受文本。提交后页面可能显示 accepted，并附带 requestId；这表示 Web gateway 已接收请求并开始后台分发，不表示 Runtime 已完成、模型已生成回复或平台已经投递。

Web gateway 会把输入规范化为 `web` 平台消息，使用 `web:${requestId}` 作为 traceId，然后异步调用 Runtime。当前没有回复查询接口或 SSE，所以页面不会显示真正的模型回复流。

::: info accepted 不是聊天回答
`202 accepted` 是接收确认。若要验证后台处理，需结合 Server 日志、SQLite 审计或接入具备 outbound transport 的平台。
:::

## 常见操作结果

**401 unauthorized** — Token 与当前 Server 实例不一致。Server 重启后刷新页面，让客户端重新取得 token。

**503 configuration_setup_required** — 所选 Profile 未 ready，Runtime ingress 没有启动。返回 Profile 管理补齐配置。

**accepted 但没有回答** — 属于当前 Web 协议的正常边界，不是前端伪造失败。

**Web UI 可用但 NapCat 不响应** — HTTP/Web 与 NapCat 生命周期相互隔离；检查 `module=adapter:napcat` 日志。

更完整的定位步骤见[故障排查](./troubleshooting)。
