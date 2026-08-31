---
title: 安装与启动
description: 安装固定版本工具链并运行 Kaguya Server 或文档站。
---

# 安装与启动

Kaguya 锁定 Node.js 24.18.0 和 pnpm 11.9.0。项目使用 `node:sqlite`，因此不要用相近大版本替代固定版本。

## 准备工具链

::: code-group

```bash [nvm ~vscode-icons:file-type-shell~]
nvm install
nvm use
node --version
```

```bash [fnm ~vscode-icons:file-type-shell~]
fnm install
fnm use
node --version
```

:::

`.nvmrc` 与 `.node-version` 都指向 `v24.18.0`。随后启用仓库声明的 pnpm：

::: code-group

```bash [Corepack ~vscode-icons:file-type-shell~]
corepack enable
corepack install --global pnpm@11.9.0
pnpm --version
```

:::

`pnpm --version` 应显示 `11.9.0`。

## 获取源码并安装

::: code-group

```bash [克隆仓库 ~vscode-icons:file-type-shell~]
git clone https://github.com/posanbu/Kaguya.git
cd Kaguya
pnpm install
```

:::

依赖版本由根目录 `pnpm-lock.yaml` 管理，不要改用 npm 或 yarn 安装。

## 以开发模式启动

至少需要一个长度不小于 16 个字符的 Gateway Token。配置目录可以使用默认的 `.data/kaguya-config`，也可以显式指定绝对路径。

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
$env:KAGUYA_GATEWAY_TOKEN = "replace-with-at-least-16-characters"
$env:KAGUYA_CONFIG_ROOT = ".data/kaguya-config"
pnpm dev
```

```bash [POSIX shell ~vscode-icons:file-type-shell~]
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
export KAGUYA_CONFIG_ROOT=".data/kaguya-config"
pnpm dev
```

:::

打开 `http://127.0.0.1:3000`。开发模式把 Vite middleware 和 HMR 挂在 Fastify 内部，不需要第二个 5173 端口。

::: code-group

```bash [健康检查 ~vscode-icons:file-type-shell~]
curl http://127.0.0.1:3000/healthz
```

:::

正常响应为 `{"status":"ok"}`。如果配置尚未完成，HTTP 与 Web UI 仍会启动，但 Runtime 和 NapCat ingress 会等待配置完成并重启。

## 生产构建与运行

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
pnpm build
$env:KAGUYA_GATEWAY_TOKEN = "replace-with-at-least-16-characters"
$env:KAGUYA_CONFIG_ROOT = ".data/kaguya-config"
pnpm start
```

```bash [POSIX shell ~vscode-icons:file-type-shell~]
pnpm build
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
export KAGUYA_CONFIG_ROOT=".data/kaguya-config"
pnpm start
```

:::

生产模式由 Fastify 提供 `apps/web/dist`。若未先构建，Server 无法找到 Web 静态产物。

## 本地预览文档站

::: code-group

```bash [热更新预览 ~vscode-icons:file-type-shell~]
cd docs
pnpm install --ignore-workspace
pnpm --ignore-workspace docs:dev
```

```bash [生产产物预览 ~vscode-icons:file-type-shell~]
cd docs
pnpm --ignore-workspace docs:build
pnpm --ignore-workspace docs:preview
```

:::

文档生产预览使用 `/Kaguya/` 基础路径，与 GitHub Pages 保持一致。

## 数据文件

默认 Runtime 数据库是 `.data/kaguya.sqlite`，demo 使用独立的 `.data/kaguya-demo.sqlite`。历史 `.data/kaguya-api.sqlite` 和 `.data/kaguya-bot.sqlite` 不会被读取、合并或删除。

::: warning 不要提交本地数据
`.data/` 中可能包含 API Key、平台凭据、消息、Prompt 和模型 trace。不要把这些文件上传到 Git、Issue、PR 或聊天记录。
:::

