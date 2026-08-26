# 网关白名单与统一配置引导更新说明

机器人接入外部平台后，并非所有消息都应进入业务处理链。若过滤发生在普通回复模块中，未授权消息仍可能提前写入数据库、发布事件或触发其他模块，因而不能形成可靠的访问边界。本次更新将平台、用户和群组白名单放到 Runtime 的统一入站位置，使不满足条件的消息在产生业务副作用前停止。

与此同时，配置缺失不再只表现为启动失败。配置仓库不存在、默认 profile 不完整或可选配置尚未确认时，Server 会进入统一配置模式，只启动 HTTP 与 Web UI，并暂停 Runtime 和 NapCat 入站。用户可以从同一个页面创建首个 profile，或者修复已有但尚不可运行的默认 profile。

## 白名单在消息落库前完成判断

白名单由以下环境变量提供：

- `KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS`：允许进入 Runtime 的平台 ID；
- `KAGUYA_GATEWAY_ALLOWLIST_USER_IDS`：允许发送消息的用户 ID；
- `KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS`：允许接收消息的群组 ID。

每个变量都使用逗号分隔，读取时会去除首尾空白并消除重复值。未配置的维度相当于通配条件；一旦某个维度存在配置，该维度就必须命中。多个已配置维度之间采用“同时满足”的关系，而不是任选其一。

例如，同时配置用户白名单和群组白名单时，只有白名单用户在白名单群组中发送的消息才能进入后续流程。只配置群组白名单时，私聊消息因为没有群组 ID，也不会满足这一约束。

过滤发生在消息持久化和 `message.ingested` 事件发布之前。被拒绝的消息不会进入数据库、Prompt、LLM 或出站回复流程；结构化日志只记录平台、adapter 和目标类型，不记录消息正文与凭据。

Web UI 消息不携带平台、用户和群组身份，因此不参与平台白名单判断，仍由现有 Bearer Token 保护。

## 不同配置缺失状态进入同一页面

Server 启动时会先检查默认 profile 的 readiness。以下三种状态都属于可以由用户补全的配置问题：

- `setup_required`：配置仓库尚未创建；
- `invalid`：默认 profile 缺少可执行的 Provider、模型或 tier；
- `review_required`：配置主体有效，但可选项尚未得到明确确认。

遇到这些状态时，Server 会记录 `server.configuration.required`，并在日志中给出 Web UI 地址。此时 `/healthz` 和配置页面可用，消息接口返回 `503 configuration_setup_required`，Runtime 与 NapCat 不会启动。

配置页面收集一个 OpenAI-compatible Provider 的 Base URL、API Key，以及互不相同的 light/heavy 模型 ID。提交接口仍要求 `KAGUYA_GATEWAY_TOKEN`，API Key 只存在于当前表单状态和受保护的 profile 文件中，不写入浏览器存储。

当配置仓库不存在时，配置管理器创建首个 profile；当默认 profile 已存在但不完整时，配置管理器保留其 ID 和名称，只替换完整的 AI、平台与插件 settings，并记录用户对空平台、空插件配置的确认。已经处于 `ready` 状态的 profile 不允许通过 setup 接口覆盖。

保存完成后，当前进程返回 `restart_required`。这是有意保留的生命周期边界：Runtime 在启动时冻结 profile 并创建模型客户端，因此配置不会在一个已经部分启动的进程中热替换。重启 Server 后，新的配置才会进入正常消息处理链。

## 可修复缺失与存储故障必须区分

统一配置入口只处理能够安全补全的业务配置。配置文件损坏、索引引用不存在的 profile、路径越界、符号链接以及文件权限异常，仍会阻止 Server 启动。此类错误可能意味着存储遭到破坏或部署权限不正确，自动覆盖会使恢复工作更加困难。

`KAGUYA_GATEWAY_TOKEN` 也仍然是启动 HTTP 服务前的必要条件。它承担配置写入接口的认证职责，不能由一个尚未认证的页面自行创建。缺少令牌、令牌长度不足，或者启用 NapCat 后缺少 WebSocket URL 时，Server 会在启动前明确报错。

## 验证范围

本次测试覆盖白名单的通配、单维度和多维度组合，确认被过滤消息不会落库、发布事件或调用 LLM；同时覆盖首次初始化、无效 profile 修复、待确认 profile 修复、重复模型拒绝、未确认可选项拒绝，以及已就绪配置不可覆盖等边界。

TypeScript 类型检查、ESLint、格式检查和 Server/Web 生产构建均已通过。全仓测试中 343 项通过；另外两项配置安全测试在当前 Windows 环境因系统不允许创建符号链接而返回 `EPERM`，失败发生在测试准备阶段，与本次白名单和配置引导逻辑无关。
