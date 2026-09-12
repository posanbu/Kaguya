# 网关入站白名单与统一配置引导

## 为什么需要这次更新

此前，平台消息进入 Runtime 后会直接落库并发布事件，缺少一个位于业务副作用之前的访问控制边界。即使后续回复模块选择忽略消息，其他订阅模块仍可能已经看到它。与此同时，只有“配置仓库不存在”能够进入首次配置页面；默认 profile 缺少模型配置或尚未确认可选项时，Server 会在 Web UI 启动前终止，用户无法从同一个入口完成修复。

本次更新解决这两个相邻问题：先在 Runtime 入站边界筛选平台消息，再把可安全修复的配置缺失状态收敛到统一 Web UI。这样，未授权消息不会进入业务链，而配置不足也不会表现为缺少解释的退出。

## 本次改动如何工作

Runtime 新增 `GatewayAllowlist`，按平台 ID、发送用户 ID 和目标群组 ID 三个维度判断平台消息。未配置的维度不参与限制；多个已配置维度必须同时满足。过滤发生在消息落库、事件发布和 LLM 调用之前，并记录不含正文与凭据的 `message.dispatch.filtered` 结构化日志。Web 消息不携带平台身份，继续由网关 Bearer Token 保护，不受平台白名单影响。

Server 配置新增三个逗号分隔的环境变量：

- `KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS`
- `KAGUYA_GATEWAY_ALLOWLIST_USER_IDS`
- `KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS`

配置引导现在统一处理 `setup_required`、`invalid` 和 `review_required`。遇到这些状态时，Server 只启动 HTTP 与 Web UI，暂停 Runtime 和 NapCat，并在日志中给出配置地址。`GET /api/v1/setup` 返回不含密钥的 readiness；经过 Bearer 认证的 `POST /api/v1/setup` 使用现有 `FileUserConfigManager` 创建首个 profile，或修复已有的默认 profile。

Web UI 会在聊天界面之前检查 readiness。需要配置时显示独立、简洁的表单，收集 OpenAI-compatible Provider URL、API Key 和互不相同的 light/heavy 模型 ID。API Key 不写入浏览器存储。保存后页面进入 `restart_required`，要求用户重启 Server，使 Runtime 在完整生命周期中重新冻结 profile 并创建模型客户端。

## 安全边界没有被配置便利性削弱

统一入口只处理配置缺失和显式确认，不处理存储损坏。配置索引损坏、profile 文件丢失、路径越界、符号链接或权限异常仍会拒绝启动，避免自动流程覆盖可能需要恢复的数据。

`KAGUYA_GATEWAY_TOKEN` 仍是启动前必须提供的引导凭据，配置写入接口不会退化为匿名接口。已经处于 `ready` 状态的 profile 也不能通过 setup API 覆盖。配置提交继续采用严格 schema，并在服务端校验 light/heavy 模型不同，不能仅依赖浏览器表单约束。

## 文档与验证

README、网关说明、架构说明、Web UI 文档和配置包文档均已更新；更完整的行为解释见 `docs/updates/2026-08-16-gateway-allowlist-and-configuration-guide.md`。

已完成以下验证：

- TypeScript 全仓构建与 Server/Web 类型检查通过；
- ESLint、Prettier 和 `git diff --check` 通过；
- 全仓 343 项测试通过；
- 两项 Windows symlink 安全测试在创建测试符号链接时因系统权限返回 `EPERM`，属于既有环境限制，测试尚未进入被测逻辑。

测试覆盖白名单通配与组合匹配、过滤前无副作用、首次配置、无效 profile 修复、待确认 profile 修复、重复模型拒绝，以及已就绪配置不可覆盖等关键边界。
