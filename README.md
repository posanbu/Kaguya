# Kaguya

Kaguya 是一个以持久化信息原子（Information Atom）组织消息处理的 TypeScript AI Bot Runtime。`apps/server` 是唯一长期运行入口：它在同一进程和端口提供 Web UI、HTTP API 与可选的 NapCat 连接，并把正规化后的平台内容提交给唯一的 `@kaguya/runtime` ingress。

每一项 Core 运行事实只有一个身份：`informationId`。入站文本、过滤结果、LLM 生命周期、assistant 文本、投递请求与投递结果都是不可变原子；原子之间用显式引用构成 DAG，而不是依赖 EventBus、会话或 trace 身份。

## 快速开始

需要 Node.js 24.18.0、pnpm 11.9.0，以及一个可连接的 PostgreSQL 数据库。`KAGUYA_DATABASE_URL` 必填；Server 不再创建 SQLite 文件，也不会转换旧 SQLite 数据。

```bash
corepack enable
pnpm install
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
export KAGUYA_DATABASE_URL="postgresql://kaguya:password@127.0.0.1:5432/kaguya"
pnpm dev
```

`KAGUYA_GATEWAY_TOKEN` 可选：显式设置（至少 16 字符）时作为最高优先级 Gateway Token。全新本地配置且仅监听 loopback 时，Server 会在终端展示一次性引导 Token；首次配置成功后生成并持久化正式凭据。

`KAGUYA_CONFIG_ROOT` 指向权限受保护的 Profile Registry。Registry 有且只有一个显式的 `selectedProfileId`；Server 仅在启动时读取这个选中的 Profile 并构造共享模型解析器，不会按消息、模块或用户选择另一个 Profile。目录尚未初始化或选中的 Profile 未就绪时，HTTP 与 Web UI 仍可用于配置，但 Runtime 和 NapCat ingress 不会启动。修改或切换选中的 Profile 后需要重启 Server 才会应用新配置。配置文件损坏或权限异常仍会拒绝启动，不会自动覆盖。初始化格式与密钥边界见 [`@kaguya/config`](packages/config/README.md)。

WebUI 的 Profile 页面旁提供独立的 NapCat 配置页。NapCat 配置实际保存到 `KAGUYA_CONFIG_ROOT/napcat.json`，保存后重启服务即可生效；若未保存过该文件，仍可使用 `KAGUYA_NAPCAT_*` 环境变量配置。

生产运行：

```bash
pnpm build
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
export KAGUYA_DATABASE_URL="postgresql://kaguya:password@127.0.0.1:5432/kaguya"
pnpm start
```

## 信息 DAG

Runtime 为入站内容创建 context 根原子，再注册 `core.message.inbound.text`。每次 `InformationCore.register()` 都先校验 Kind、payload 和引用，生成 `informationId` 并提交 PostgreSQL 账本；只有提交成功后，才向该 Kind 的当前消费者并发广播。没有消费者的原子同样会保留。

默认链路是：

```text
core.runtime.context
  -> core.message.inbound.text
  -> core.reply.requested
  -> core.llm.requested
  -> core.llm.completed | core.llm.failed
  -> core.message.assistant.text
  -> core.delivery.requested
  -> core.delivery.delivered | core.delivery.failed
```

过滤器通过注册下一个 Kind 来推进链路；拒绝时只注册 `filter.decision`。消费者抛出或 reject 时，输入原子不会回滚，其他消费者仍会独立完成，Core 会追加 `consumer.failed` 作为失败事实。消费者不会因此自动重试。

## 常用命令

- `pnpm dev`：以开发模式启动唯一 Kaguya Server 与内嵌 Vite。
- `pnpm build`：构建 packages、Server 与 Web 产物。
- `pnpm start`：以生产模式启动构建后的 Server。
- `pnpm demo`：连接 `KAGUYA_DATABASE_URL`，运行确定性信息 DAG，并输出根 `informationId` 与 Kind 计数。
- `pnpm test`：运行单元和集成测试。
- `pnpm typecheck`：检查 TypeScript project references 和 Web。
- `pnpm lint`：运行 ESLint。
- `pnpm prompt:test`：在阻断外部出口后验证 Prompt 结构。

## 统一配置

**`KAGUYA_DATABASE_URL`** — 必填。PostgreSQL information ledger 的连接 URL；不会写入普通日志。

**`KAGUYA_CONFIG_ROOT`** — 默认 `.data/kaguya-config`。保存 Profile Registry、Provider 和模型配置，必须按敏感数据保护。

**`KAGUYA_GATEWAY_TOKEN`** — 可选。用于受保护的配置与消息 API。

**`KAGUYA_HOST` / `KAGUYA_PORT`** — 默认 `127.0.0.1` / `3000`。唯一 Server 监听地址与端口。

**`KAGUYA_CORS_ORIGINS`、`KAGUYA_TRUST_PROXY`、`KAGUYA_RATE_LIMIT_MAX`、`KAGUYA_RATE_LIMIT_WINDOW_MS`** — 跨域、反向代理与请求限流配置。

**`KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS`、`KAGUYA_GATEWAY_ALLOWLIST_USER_IDS`、`KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS`** — 平台入站白名单；命中检查在提交 Runtime 前执行。

**`KAGUYA_NAPCAT_ENABLED`、`KAGUYA_NAPCAT_WS_URL`、`KAGUYA_NAPCAT_ACCESS_TOKEN`、`KAGUYA_NAPCAT_SELF_ID`、`KAGUYA_NAPCAT_RECONNECT_MS`** — 可选 NapCat 连接配置。

`KAGUYA_DATABASE_PATH` 和旧的多应用 SQLite 变量会导致启动失败。Provider key、base URL 与模型不从环境变量读取，而是由当前全局选中的 Profile 提供。完整列表见[环境变量参考](docs/reference/environment-variables.md)。

## 仓库结构

```text
apps/server/        唯一 composition root：HTTP、Web、NapCat、Runtime 与关闭流程
apps/web/           React/Vite 同源浏览器客户端
apps/demo/          PostgreSQL 信息 DAG 的确定性演示 runner
packages/runtime/   信息 ingress、DAG 组合、LLM 生命周期与投递结果
packages/engine/    InformationCore、Kind Registry、并发广播与 ModuleHost
packages/modules/   消息 Kind 与 filter/LLM 回复模块
packages/database/  PostgreSQL 信息账本、迁移与日志投影 outbox
packages/llm/       LLM 调用、输出校验与错误归一化
packages/prompt/    Prompt 编译与 provenance
packages/logger/    结构化日志、上下文与脱敏
packages/schema/    跨包数据契约
packages/sdk/       Information Kind 与模块定义 API
packages/platform-adapters/ OneBot/NapCat/Web 正规化与 transport 契约
```

## 文档

- [文档站首页](docs/index.md)
- [安装与启动](docs/guide/installation.md)
- [配置 Kaguya](docs/guide/configuration.md)
- [Web UI](docs/guide/webui.md)
- [运行时架构](docs/developers/architecture.md)
- [信息模块 SDK](docs/developers/information-modules.md)
- [HTTP API](docs/reference/http-api.md)
- [环境变量](docs/reference/environment-variables.md)
- [配置包说明](packages/config/README.md)
- [贡献指南](CONTRIBUTING.md)

## 当前边界

模块是受信任的同进程代码。Core 按当前订阅者快照实时广播：没有持久订阅、离线补投、工作队列、消费者优先级或自动重试。系统同样没有去重、热更新、模块沙箱、隐式会话分组或 Web 回复读取/SSE 通道。旧 SQLite 数据与旧配置索引不会自动导入、转换或删除。
