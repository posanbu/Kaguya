---
title: 快速上手
description: 从安装 Kaguya 到在浏览器中完成第一次聊天。
---

# 快速上手

Kaguya 是一个可以在网页和 QQ 中聊天的 AI 机器人。先在浏览器里完成一次私聊，再按需要连接 QQ、修改角色或开启记忆。

## 准备什么

- Git、Node.js **24.18.0** 和 pnpm **11.9.0**。
- 已启动的 Docker Desktop、OrbStack 或其他兼容 Docker CLI 的引擎，用于本地 PostgreSQL 17。
- 一个兼容 OpenAI API 的模型服务：服务地址、API Key 和可用模型名称。

工具尚未安装时，先看[安装与启动](./installation)。

## 启动 Kaguya

::: code-group

```bash [终端 ~vscode-icons:file-type-shell~]
git clone https://github.com/posanbu/Kaguya.git
cd Kaguya
pnpm install
pnpm dev
```

:::

首次启动会准备本地数据库和配置文件。保持终端运行，打开其中打印的完整 **Kaguya access URL**。默认端口是 `3000`，链接末尾包含本次启动的访问令牌，请勿分享。

## 填写模型

在配置页填写 **Base URL、API Key、轻量模型、重量模型**。只有一个模型时，Light 和 Heavy 可以填写同一个模型名称；其余参数先保留默认值，Memory 可以暂时关闭。

保存配置后，进入“配置生效管理”，点击“应用当前配置”。看到已生效且 Runtime 可用后，进入“消息”页。若页面提示需要重启，回到终端按 `Ctrl+C`，再次执行 `pnpm dev`，并打开新打印的访问链接。

每个字段的含义见[模型配置](./models)。

## 发送第一条消息

在“消息”页输入一句话并发送。回复完成后会显示在对话中，当前不逐字输出。一直没有回答时，按[机器人不回复](./troubleshooting#机器人不回复)检查。

## 接下来做什么

- [接入 QQ](./napcat)：连接 NapCat，并设置入站和出站白名单。
- [角色与回复风格](./persona)：修改名称、人设和说话方式。
- [发言频率与等待](./reply-settings)：调整群聊参与和连续消息的等待时间。
- [记忆配置](./memory)：让历史消息参与后续回复。
- [配置概览](./configuration)：查找其他设置的入口和生效方式。
