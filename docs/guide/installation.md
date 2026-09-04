---
title: 安装与启动
description: 安装固定版本工具链并以 PostgreSQL 启动 Kaguya Server 或文档站。
---

# 安装与启动

Kaguya 锁定 Node.js 24.18.0 和 pnpm 11.9.0，并要求一个 PostgreSQL information ledger。Server 与 demo 都必须设置 `KAGUYA_DATABASE_URL`；不再支持本地 SQLite 或数据库路径配置。

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

Gateway Token 可选：未设置时每次启动自动生成随机 token，Web UI 页面加载时自动获取；需要跨重启稳定的 token 时可显式设置至少 16 个字符。配置目录可以使用默认 `.data/kaguya-config`，也可以指定绝对路径。

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
$env:KAGUYA_CONFIG_ROOT = ".data/kaguya-config"
$env:KAGUYA_DATABASE_URL = "postgresql://kaguya:password@127.0.0.1:5432/kaguya"
pnpm dev
```

```bash [POSIX shell ~vscode-icons:file-type-shell~]
export KAGUYA_CONFIG_ROOT=".data/kaguya-config"
export KAGUYA_DATABASE_URL="postgresql://kaguya:password@127.0.0.1:5432/kaguya"
pnpm dev
```

:::

打开 `http://127.0.0.1:3000`。开发模式把 Vite middleware 和 HMR 挂在 Fastify 内部，不需要第二个 5173 端口。

::: code-group

```bash [健康检查 ~vscode-icons:file-type-shell~]
curl http://127.0.0.1:3000/healthz
```

:::

正常响应为 `{"status":"ok"}`。首次启动时 Registry 会有一个选中的 `selectedProfileId`；若该 Profile 未就绪，HTTP 与 Web UI 仍启动以供配置，但 Runtime、数据库连接和 NapCat ingress 会等待 Profile 就绪并在重启后启动。

## 生产构建与运行

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
pnpm build
$env:KAGUYA_CONFIG_ROOT = ".data/kaguya-config"
$env:KAGUYA_DATABASE_URL = "postgresql://kaguya:password@127.0.0.1:5432/kaguya"
pnpm start
```

```bash [POSIX shell ~vscode-icons:file-type-shell~]
pnpm build
export KAGUYA_CONFIG_ROOT=".data/kaguya-config"
export KAGUYA_DATABASE_URL="postgresql://kaguya:password@127.0.0.1:5432/kaguya"
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

## 数据与迁移边界

`KAGUYA_DATABASE_URL` 指向 PostgreSQL 中的 information ledger。Runtime 就绪后通过 `KaguyaDatabase.connect()` 连接该 URL，并在一个事务中创建或迁移可重复执行的 schema。payload 保存为 `JSONB`，原子和显式引用由外键保护；原子、引用与日志投影 outbox 在同一事务写入，日志随后异步投影。原子与引用只允许追加。旧 `.data/*.sqlite` 文件不会被读取、合并、删除或自动转换；请自行保留或处理历史数据。

::: warning 保护凭据与数据
数据库 URL、Profile store、平台凭据与本地数据都可能包含敏感信息。不要把它们上传到 Git、Issue、PR 或聊天记录。
:::
