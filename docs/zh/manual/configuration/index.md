# 网关入站白名单与 Profile 配置引导

## 为什么需要这次更新

此前，平台消息进入 Runtime 后会直接落库并发布事件，缺少一个位于业务副作用之前的访问控制边界。即使后续回复模块选择忽略消息，其他订阅模块仍可能已经看到它。与此同时，旧配置引导只把“配置仓库不存在”视为可修复状态；一旦当前全局选中的 Profile 不完整，或者 warning 尚未确认，Server 可能在暴露 Web UI 修复入口之前就终止。

现行设计把这两个边界一起收紧：先在 Runtime 入站边界筛选平台消息，再把可安全修复的 selected Profile 状态收敛到统一的 Web UI Profile 管理页面。这样，未授权消息不会进入业务链，而配置不足也会得到明确、单一的修复路径。

## 本次改动如何工作

Runtime 新增 `GatewayAllowlist`，按平台 ID、发送用户 ID 和目标群组 ID 三个维度判断平台消息。未配置的维度不参与限制；多个已配置维度必须同时满足。过滤发生在消息落库、事件发布和 LLM 调用之前，并记录不含正文与凭据的 `message.dispatch.filtered` 结构化日志。Web 消息不携带平台身份，继续由网关 Bearer Token 保护，不受平台白名单影响。

Server 配置新增三个逗号分隔的环境变量：

- `KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS`
- `KAGUYA_GATEWAY_ALLOWLIST_USER_IDS`
- `KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS`

配置引导现在围绕全局 `selectedProfileId` 统一处理 `setup_required`、`invalid`、`review_required` 与 `restart_required`。遇到 selected Profile 未就绪时，Server 只启动 HTTP 与 Web UI，暂停 Runtime 和 NapCat，并通过 `GET /api/v1/setup` 返回不含密钥的 setup 状态。

配置写入已经不再通过 `POST /api/v1/setup` 完成。Web UI 现在使用显式的 Profile 管理接口：

- `GET /api/v1/profiles`：读取 metadata 集合和 `selectedProfileId`
- `POST /api/v1/profiles`：创建命名 Profile
- `GET /api/v1/profiles/:profileId`：读取完整、含密钥的指定 Profile
- `PUT /api/v1/profiles/:profileId`：完整替换指定 Profile
- `PUT /api/v1/profiles/selection`：显式修改 `selectedProfileId`
- `DELETE /api/v1/profiles/:profileId`：删除允许删除的 Profile

对于全新配置根，显式 bootstrap 会创建保留的空 `default` Profile，并将 `selectedProfileId` 设为 `"default"`。用户随后可以配置 `default`，或者创建新的命名 Profile，再单独选择它。

Web UI 会在聊天界面之前检查 setup 状态。需要配置时会进入 Profile 管理界面，按 `profileId` 加载当前 Profile，并在完整正文基础上编辑，而不是用空表单覆盖未显示字段。API Key 不写入浏览器存储。如果保存或切换后，当前 selected Profile 仍然处于 `invalid` 或 `review_required`，页面会继续展示 readiness issues 与 warnings，而不会提示重启。选择某个 Profile，或完整替换当前 selected Profile，都会锁存一次重启要求；只有当该 selected Profile 已经 ready 时，页面才会进入 `restart_required`，要求用户重启 Server，使 Runtime 在下一个启动周期里加载该 selected Profile 并创建模型客户端。

## 安全边界没有被配置便利性削弱

可恢复的统一入口只处理 selected Profile 缺失、未完成或 warning 待确认这类状态，不处理存储损坏。配置索引损坏、Profile 文件丢失、路径越界、符号链接或权限异常仍会拒绝启动，避免自动流程覆盖可能需要恢复的数据。

网关 token 由 Server 在启动时确定：未设置 `KAGUYA_GATEWAY_TOKEN` 时自动生成（日志 `server.token.generated`），Web UI 加载页面时自动获取，配置写入接口不会退化为匿名接口。匿名 setup 模式只能看到 metadata、issues 与 warnings；完整 Profile 的读取和修改仍要求管理认证。配置提交继续采用严格 schema，并在服务端校验 light/heavy 模型不同，不能仅依赖浏览器表单约束。

## 文档与验证

当前生效的配置文档与服务端文档都已经统一到 v3 registry 契约：运行时只有一个显式的 `selectedProfileId`，`GET /api/v1/setup` 只暴露 setup 状态，Profile 创建/读取/替换/选择/删除全部通过 `/api/v1/profiles*` 完成；当用户选择某个 Profile，或替换当前 selected Profile 后，只要该 selected Profile 已 ready，页面就会进入 `restart_required`，并在重启后真正进入 Runtime。
