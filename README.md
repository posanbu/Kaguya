# Kaguya

Kaguya 是一个使用 TypeScript 开发的 AI Bot Runtime。它以持久化的 Information Atom 记录消息、模型调用和投递结果，并通过显式引用组成可追踪的信息 DAG。

`apps/server` 是统一的运行入口。它在同一进程中提供 Web UI、HTTP API、Runtime 和可选的 NapCat 连接。

## 主要能力

- Information Atom 为每项运行事实提供稳定身份。
- 模块系统负责消息观察、决策、模型调用和回复生成。
- PostgreSQL 保存信息账本、引用关系和日志投影。
- Web UI 管理 Profile、模型、NapCat、Memory 和访问规则。
- NapCat 通过 OneBot 协议连接 QQ。

## 快速开始

开发环境需要 Node.js 24.18.0、pnpm 11.9.0，以及已启动的 Docker Desktop、OrbStack 或其他兼容 Docker CLI 的引擎。

```bash
corepack enable
pnpm install
pnpm dev
```

配置默认保存在 `.data/kaguya-config`。可以通过 `KAGUYA_CONFIG_ROOT` 指定其他目录。

`pnpm dev` 会准备 PostgreSQL 17，并启动 Kaguya Server。启动成功后，终端会输出包含临时 Gateway Token 的 `Kaguya access URL`。使用该地址进入 Web UI 并完成模型与平台配置。

## 常用命令

```bash
pnpm dev
pnpm build
pnpm start
pnpm test
pnpm typecheck
pnpm lint
```

`pnpm dev` 启动开发环境。`pnpm build` 构建全部应用和软件包。`pnpm start` 启动生产构建。其余命令分别运行测试、类型检查和代码检查。

## 文档与参与

完整的安装、配置、使用和架构说明见 [Kaguya 文档](https://posanbu.github.io/Kaguya/)。

问题和功能建议提交到 [GitHub Issues](https://github.com/posanbu/Kaguya/issues)。参与开发前请阅读[贡献指南](CONTRIBUTING.md)。项目使用 [GNU Affero General Public License v3.0](LICENSE)。
