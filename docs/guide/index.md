---
title: 使用指南
description: 从安装、首次配置到 Web UI 的 Kaguya 使用入口。
---

# 使用指南

Kaguya 是一个事件驱动、模块可插拔的 TypeScript AI Bot Runtime。当前唯一长期运行入口是 `apps/server`：它在同一进程、同一端口提供 Web UI、HTTP API，并可选连接 NapCat。

::: tip 推荐阅读顺序
第一次使用时，依次阅读“安装与启动 → 配置 Kaguya → 使用 Web UI”。如果需要接入模块或理解消息为什么这样流动，再进入开发文档。
:::

## Kaguya 当前能做什么

**接收消息** — Web UI 通过 HTTP 提交文本；NapCat 可以把 OneBot 消息标准化后交给同一个 Runtime。

**运行模块链** — 默认演示链由 always filter、LLM reply 和 outbound request 组成。模块也可以选择不回复，或发布自己的事件。

**管理模型配置** — Web UI 可以创建、编辑、选择和删除 Profile。Provider、API Key 和 light/heavy 模型目标保存在权限受保护的 profile store。

**记录执行过程** — SQLite 保存消息、LLM trace 与出站审计；结构化日志通过 requestId、traceId 和事件因果字段关联执行过程。

## 一次典型启动

```mermaid
flowchart LR
  A[准备 Node.js 与 pnpm] --> B[安装依赖]
  B --> C[启动统一 Server]
  C --> D[页面自动取得 Gateway Token]
  D --> E{配置是否就绪}
  E -- 否 --> F[在 Web UI 补齐或确认配置]
  F --> G[重启 Server]
  E -- 是 --> H[进入消息界面]
  G --> H
```

## 继续阅读

### 安装与启动

查看[安装与启动](./installation)，准备固定版本工具链，并分别运行开发模式、生产模式或文档站。

### 首次配置

查看[配置 Kaguya](./configuration)，理解 setup mode、profile、模型层级和敏感文件边界。

### 浏览器界面

查看[使用 Web UI](./webui)，了解同源页面、Gateway Token 的保存位置以及当前响应边界。

### 遇到问题

查看[故障排查](./troubleshooting)，按页面现象、HTTP 状态和日志事件定位问题。

## 需要提前知道的边界

Kaguya 当前没有持久事件队列、自动重试、去重、模块热更新或沙箱。HTTP 消息接口只确认 Web gateway 已接受消息，不等待后台 Runtime 完成，也不返回模型回答或提供 SSE。Core 不按用户、群聊或来源自动组织上下文；后续数据关系需要由显式信息引用和模块逻辑表达。
