---
title: 安装与启动
description: 准备工具、从源码启动 Kaguya，并切换到生产运行。
---

# 安装与启动

当前从源码运行 Kaguya。首次本地启动使用开发模式：它会准备 PostgreSQL，网页和服务使用同一个端口。

## 获取源码

先安装 Git，再在终端执行：

::: code-group

```bash [克隆仓库 ~vscode-icons:file-type-shell~]
git clone https://github.com/posanbu/Kaguya.git
cd Kaguya
```

:::

下面的命令都在 `Kaguya` 仓库根目录运行。

## 准备 Node.js 和 pnpm

使用 Node.js **24.18.0**。已经安装 nvm 或 fnm 时，可按仓库版本文件切换：

::: code-group

```bash [nvm ~vscode-icons:file-type-shell~]
nvm install
nvm use
```

```bash [fnm ~vscode-icons:file-type-shell~]
fnm install
fnm use
```

:::

Windows 用户也可以直接安装对应版本的 Node.js，随后在 PowerShell 中继续操作。安装 pnpm 并核对版本：

::: code-group

```bash [安装 pnpm ~vscode-icons:file-type-shell~]
npm install --global pnpm@11.9.0
node --version
pnpm --version
```

:::

应分别显示 `v24.18.0` 和 `11.9.0`。仓库依赖使用 pnpm 安装。

## 准备数据库

安装并启动 Docker Desktop、OrbStack 或其他兼容 Docker CLI 的引擎，然后检查：

::: code-group

```bash [检查 Docker ~vscode-icons:file-type-shell~]
docker info
```

:::

能正常返回引擎信息后继续。`pnpm dev` 会创建或复用本地 PostgreSQL 17，无需手动创建数据库。已有外部 PostgreSQL 17 的部署方式见[运行参数](./runtime)。

## 安装依赖并启动

::: code-group

```bash [启动 ~vscode-icons:file-type-shell~]
pnpm install
pnpm dev
```

:::

打开终端打印的完整 `Kaguya access URL`，按[快速上手](./index#填写模型)完成模型配置。只打开 `http://127.0.0.1:3000` 会缺少访问令牌；每次重启都要使用新链接。

在终端按 `Ctrl+C` 停止 Kaguya。数据库容器和数据卷会保留，下一次启动继续使用。

## 长期运行

首次配置完成后，可以停止开发服务，构建并以生产模式运行：

::: code-group

```bash [生产模式 ~vscode-icons:file-type-shell~]
pnpm build
pnpm start
```

:::

`pnpm start` 使用已保存的配置和已构建的网页，**不会启动 Docker 或数据库**。使用本地托管数据库时，应保持 Docker 运行；机器重启后可先执行 `pnpm postgres:start`，再执行 `pnpm start`。

如需换端口、连接外部数据库或指定配置目录，查看[运行参数](./runtime)。更新版本和保留数据的方法见[更新与备份](./maintenance)。
