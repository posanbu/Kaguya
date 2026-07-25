# Kaguya

Kaguya 是一个以事件和有向工作流为核心的 TypeScript AI Bot 基础设施原型。它把消息处理、短间隔心跳、定时记忆整理、Prompt 组装、LLM 调用和 SQLite 追踪拆成可替换的边界；当前仓库不包含社交平台适配器或 Web UI。

当前实现包含：

- 统一的事件信封、Zod schema 与 SDK 定义；
- 可拦截、可观察的事件总线和无环工作流引擎；
- 手动、固定间隔与六字段 cron 触发器；
- 带稳定排序和 SHA-256 来源摘要的 Prompt 编译器；
- 基于 Vercel AI SDK 的结构化 LLM 边界与完整调用 trace；
- SQLite 消息、记忆、节点运行和 LLM trace 仓储；
- 多份敏感用户配置、会话选择与默认回退；
- 消息、心跳、定时记忆三条可执行示例工作流；
- 不依赖远端模型或 API key 的确定性测试、demo 和 Promptfoo 回归测试；`prompt:test` 会阻断 CLI 外部出口。

## 快速开始

需要 Node.js 24.18.0 和 pnpm 11.9.0。仓库同时提供 `.nvmrc` 与 `.node-version`。

```bash
nvm install
nvm use
corepack enable
corepack install --global pnpm@11.9.0
pnpm install
pnpm test
pnpm prompt:test
pnpm demo
```

也可以使用 fnm：

```bash
fnm install
fnm use
```

`pnpm demo` 使用 `ai/test` 的确定性模型，运行三条工作流并在 `.data/kaguya-demo.sqlite` 写入本地演示数据。重复运行前只清理固定 demo session 及其 trace，不会删除其他会话数据。

## 常用命令

| 命令                | 用途                                                  |
| ------------------- | ----------------------------------------------------- |
| `pnpm build`        | 构建全部 TypeScript project references                |
| `pnpm typecheck`    | 以 TypeScript build mode 检查类型，并可能更新 `dist/` |
| `pnpm lint`         | 运行 ESLint                                           |
| `pnpm format`       | 使用 Prettier 格式化仓库                              |
| `pnpm format:check` | 检查格式但不改文件                                    |
| `pnpm test`         | 运行单元与集成测试                                    |
| `pnpm prompt:test`  | 阻断外部出口后在本地验证四类 Prompt 的结构            |
| `pnpm demo`         | 运行消息、心跳和定时记忆的确定性端到端示例            |

`prompt:test` 的自定义 provider 只通过 source bridge 加载仓库源码，不创建模型、不读取 API key，也不自行访问网络。固定的 Promptfoo 0.121.19 即使收到 telemetry disable 标志仍可能尝试上报一次“telemetry disabled”；脚本保留 telemetry/update disable 标志，同时把大小写 HTTP(S)/ALL proxy 都指向不可达的 `127.0.0.1:9`，并清空 `NO_PROXY` 绕过列表，因此该尝试不能离开 localhost。

## 仓库结构

```text
apps/demo/          三条工作流的组装、确定性模型与可执行示例
packages/schema/    跨包数据契约
packages/sdk/       事件、监听器、节点与工作流定义 API
packages/engine/    事件总线与工作流执行器
packages/scheduler/ 手动、interval 与 cron 触发器
packages/prompt/    Prompt 编译与来源追踪
packages/llm/       LLM 调用、结构校验与 trace
packages/database/  SQLite 迁移和 repositories
packages/config/    敏感用户配置 profile 的 JSON 存储与会话选择
promptfoo/          离线 Promptfoo provider 与结构断言
docs/               调研、架构、会议记录和设计文档
```

## 文档

- [架构说明](docs/architecture.md)：包边界、事件字段、节点/边、工作流、Prompt 与数据库追踪。
- [配置包说明](packages/config/README.md)：敏感配置的 API、存储边界和泄漏处置。
- [用户配置设计](docs/superpowers/specs/2026-07-25-user-configuration-management-design.md)：profile、会话选择与敏感文件处理的已批准设计。
- [人工待实现路线图](docs/remaining-work.md)：生产闭环、可靠性与后续扩展所需的人工决策、工程任务和验收标准。
- [MaiBot 调研](docs/maibot-analysis.md)：直接 LLM 调用入口、触发关系、Prompt 来源和持久化影响。
- [贡献指南](CONTRIBUTING.md)：环境、开发流程、新增子包、迁移规则和提交前检查。
- [会议记录](docs/meeting-0722.md)：原始需求与分工。
- [初始化设计](docs/superpowers/specs/2026-07-23-kaguya-init-design.md)：范围和设计决策。

## 当前边界

这是基础设施原型，而不是可直接连接聊天平台的完整 Bot。`@kaguya/config` 已实现敏感 profile 的本地存储、会话选择和默认回退，但当前 demo 尚未读取这些 profile。配置 UI、真实 provider 的执行装配，以及平台和插件的运行时接线仍属于后续工作；并发队列、工作流循环/重试策略和生产部署也尚未实现。当前 demo 的 policy 和 persona 是固定样例文本；业务应用应在应用层装配自己的数据源和策略。
