# Web 会话与真 enqueue 更新记录

之前网关对 Web 消息同步等待整条模块链（含 LLM 调用）完成后才返回 `202`，而 Web 输入生成的回复在 `selectOutbound` 处被直接丢弃，Web UI 只能展示“已提交”，无法展示或查询回复。本次更新把网关的职责收回到“接入与基础防护”：消息通过 `MessageIngress.enqueue()` 交给核心层，核心层落库后立即返回 `202`，模块链在后台继续；同时 Web UI 获得会话历史与回复展示能力。

## 202 表示“已接受并持久化”

`POST /api/v1/messages` 现在接受可选 `sessionId`（1–128 字符，首字符为字母或数字，其余为字母、数字、点、下划线、冒号、连字符；首尾空白被 trim；缺省时 Server 生成 UUID）。消息落库后接口立即返回 `202` 并回显实际生效的 `sessionId`；LLM 与模块链在后台继续，后台失败只记录 `message.processing.failed` 日志（含 traceId，不含消息正文），不影响已返回的回执。

网关不再直接调用完整的 Runtime dispatch 管线，只依赖 `MessageIngress` 与 `SessionMessageReader` 两个结构化接缝，`KaguyaRuntime` 天然同时满足两者。平台入站（NapCat、demo）保持原有同步 dispatch 契约不变。

## 回复持久化与会话查询

Web 输入经过 LLM 生成成功后，默认 reply 模块把回复作为 `assistant` 消息持久化到同一会话，metadata 携带 `traceId`、`requestId`、`sourceMessageId` 和 `sessionId`；平台来源行为不变，仍走 outbound transport。

新增 `GET /api/v1/sessions/:sessionId` 按时间正序返回指定会话的 `user` 与 `assistant` 消息（默认最多最近 200 条），未知会话返回 `200` 和空列表。该路由使用独立限流桶（120 次/60 秒），不与消息接口共享全局桶，避免 UI 轮询把消息提交挤到 429。

`sessionId` 只存于 `messages.metadata_json`：无新列、无数据库迁移，不进入模块上下文与事件 payload，也不参与平台分组语义。这是 Web 入口的过渡性限定例外，收敛计划见 [remaining-work](../remaining-work.md)。

## Web UI 行为

页面把 `sessionId` 存在 `sessionStorage`（每个标签页独立）。进入聊天视图时先查询会话接口恢复历史；发送后 202 立即显示“服务已接收”，随后每 2.5 秒轮询（标签页隐藏时暂停，回到前台恢复），`assistant` 回复以左对齐气泡展示。全部未确认请求收到回复、202 后 300 秒仍无回复（标记“等待回复超时”）或返回 401 时停止轮询。客户端在提交前用 `x-request-id` 请求头预生成 requestId，便于客户端与服务端日志确定性关联。

## 边界与测试

- `RuntimeWebMessage.sessionId` 变为必填字段；in-repo 唯一 Web 调用方 `apps/demo` 已同步更新，外部直接调用 Runtime 的集成需补传。
- 回复持久化由 `runtime.start()` 用默认模块链装配 `messageWriter`；替换自定义 `moduleDefinitions` 的部署默认没有 Web 回复持久化。
- `listBySession` 使用 `json_extract` 全表扫描，没有索引；加索引需要数据库迁移，超出本次范围。
- composition 测试的绿色依赖 `close()` 排空在途后台工作，已用专门的 runtime 测试钉死该行为。
- `messagePersistedEvent` 从 `@kaguya/runtime` 移入 `@kaguya/modules`，runtime 侧 re-export 保持公共 API 不变。

TypeScript 类型检查、ESLint、格式检查和 Server/Web 生产构建均已通过。全仓测试中 352 项通过；另外两项配置安全测试在当前 Windows 环境因系统不允许创建符号链接而返回 `EPERM`，失败发生在测试设置阶段，与本次更新无关。
