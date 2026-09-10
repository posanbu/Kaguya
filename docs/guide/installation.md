---
title: 安装与启动
description: 安装固定版本工具链并以 PostgreSQL 启动 Kaguya Server 或文档站。
---

# 安装与启动

Kaguya 锁定 Node.js 24.18.0、pnpm 11.9.0 和 PostgreSQL 17。本地开发还需要已启动的 Docker Desktop、OrbStack 或其他兼容 Docker CLI 的引擎；开发验收不使用 Compose、PGlite 或 SQLite 代替 PostgreSQL 17。

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

确认 Docker-compatible engine 可用：

::: code-group

```bash [Docker Desktop / OrbStack ~vscode-icons:file-type-shell~]
docker info
```

:::

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

Server 每次启动自动生成随机 Gateway Token。配置目录可以使用默认 `.data/kaguya-config`，也可以指定绝对路径。

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
$env:KAGUYA_CONFIG_ROOT = ".data/kaguya-config"
pnpm dev
```

```bash [POSIX shell ~vscode-icons:file-type-shell~]
export KAGUYA_CONFIG_ROOT=".data/kaguya-config"
pnpm dev
```

:::

成功监听后，从终端打开完整的 `Kaguya access URL`，其中包含本次启动的 `#gatewayToken=` fragment。根地址不会自动取得 token。开发模式把 Vite middleware 和 HMR 挂在 Fastify 内部，不需要第二个 5173 端口。

::: code-group

```bash [健康检查 ~vscode-icons:file-type-shell~]
curl http://127.0.0.1:3000/healthz
```

:::

正常响应为 `{"status":"ok"}`。`pnpm dev` 会先创建或恢复 `kaguya-postgres-17`，等待 `pg_isready`，验证实际服务器为 PostgreSQL 17，初始化空 schema 或验证完整 v1，并同步 Runtime Kind；只有整条链成功才启动 Server。

首次开发启动若 selected Profile 完全缺少 `runtime`，命令会保留 AI、Memory、平台、插件与 review 内容，再补入 loopback 默认值和托管数据库地址。部分损坏的 runtime 不会被自动覆盖。AI 配置未就绪或数据库失败时，HTTP、Web UI 与 Adapter 仍运行。进入 Gateway / Adapter 查看原因，修复后重启。

## 管理本地 PostgreSQL

::: code-group

```bash [生命周期命令 ~vscode-icons:file-type-shell~]
pnpm postgres:start
pnpm postgres:status
pnpm postgres:check
```

```bash [首次改用 55432 端口 ~vscode-icons:file-type-shell~]
pnpm postgres:start -- --port 55432
```

:::

`start` 创建或恢复实例、等待健康并准备严格 v1 schema。`status` 只报告配置模式、容器状态、健康、版本和端口，不启动容器也不修改 schema。`check` 不改变容器生命周期，但会验证连接、PostgreSQL 17、完整 v1 schema 与 Kind。

容器固定为 `kaguya-postgres-17`，镜像固定为 `postgres:17-alpine`，数据卷固定为 `kaguya-postgres-17-data`，端口只绑定 `127.0.0.1`。同名外部容器、错误镜像、label、挂载、端口或实际大版本会安全失败。已有容器端口不匹配时不会自动重建。停止 Server、发送退出信号或结束测试都不会停止或删除容器、卷及开发数据。

本地 `pnpm test:postgres` 自动复用同一实例，并把测试 URL 只注入 Vitest 子进程。CI 可以显式设置 `KAGUYA_TEST_DATABASE_URL`，此时命令不访问 Docker 或 Profile。每个真实数据库 suite 使用随机 `kaguya_test_*` schema，且只清理自己的 schema。

## 生产构建与运行

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
pnpm build
$env:KAGUYA_CONFIG_ROOT = ".data/kaguya-config"
pnpm start
```

```bash [POSIX shell ~vscode-icons:file-type-shell~]
pnpm build
export KAGUYA_CONFIG_ROOT=".data/kaguya-config"
pnpm start
```

:::

生产模式由 Fastify 提供 `apps/web/dist`。若未先构建，Server 无法找到 Web 静态产物。`pnpm start` 只读取 selected Profile 并检查其数据库，绝不调用 Docker；需要外部数据库时，直接编辑 Profile JSON 的 `runtime.databaseMode` 和 `runtime.databaseUrl`。

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

selected Profile 的 `runtime.databaseUrl` 指向 PostgreSQL information ledger；未声明 `databaseMode` 的旧 Profile 按 `external` 处理。启动期间，Server 会在任何 ingress 监听前检查连接和 PostgreSQL 17，并在一个事务中创建或迁移可重复执行的 schema。payload 保存为 `JSONB`，原子和显式引用由外键保护；原子、引用与日志投影 outbox 在同一事务写入，日志随后异步投影。原子与引用只允许追加。旧 `.data/*.sqlite` 文件不会被读取、合并、删除或自动转换；请自行保留或处理历史数据。

::: warning 保护凭据与数据
数据库 URL、Profile store、平台凭据与本地数据都可能包含敏感信息。不要把它们上传到 Git、Issue、PR 或聊天记录。
:::
