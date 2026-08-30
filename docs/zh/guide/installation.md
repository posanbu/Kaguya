---
title: 安装与启动
description: Kaguya 与文档站的本地启动入口。
---

# 安装与启动

本页预留 Kaguya 的完整安装、升级和部署说明。框架阶段先提供可验证的文档站本地预览流程。

## 前置条件

**Node.js** — 版本以仓库根目录的 `.nvmrc`、`.node-version` 和 `package.json` 为准。

**pnpm** — 版本以根 `package.json` 的 `packageManager` 与 `engines` 为准。

**Git** — 用于同步源码、创建分支和提交文档修改。

## 本地预览文档站

::: code-group

```bash [文档开发服务器 ~vscode-icons:file-type-shell~]
cd docs
pnpm install
pnpm docs:dev
```

```bash [生产构建与预览 ~vscode-icons:file-type-shell~]
cd docs
pnpm docs:build
pnpm docs:preview
```

:::

开发服务器用于写作时热更新；生产预览读取 `.vitepress/dist`，用于在推送前验证最终静态产物。

## 后续内容

### 源码安装

补充各平台安装、环境变量和启动检查。

### 容器部署

补充镜像、数据卷、健康检查和反向代理。

### 升级与回滚

补充版本兼容、数据库边界和故障恢复。
