# 后续工作

当前 Runtime 已完成 #37：所有入站只携带消息内容与入口回执，Core、SDK、配置和新
SQLite 格式都不再维护对话分组标识。旧配置索引和旧数据库会被明确拒绝，不会自动
迁移或删除。

## 实施顺序

1. **#38 信息原子与 Kind Registry**
   - 定义只有 `informationId` 的信息原子契约。
   - 通过 Kind 注册、校验不同载荷，并允许信息 ID 之间建立显式类型引用。
2. **#39 异步账本、SQLite 与日志投影**
   - 以追加式信息账本作为事实来源。
   - SQLite 先实现存储抽象；运行日志从账本事件投影，不反向充当事实来源。
3. **#40 Core DAG 与模块 SDK**
   - 模块显式订阅输入 Kind、产生输出 Kind。
   - Core 只负责类型校验、DAG 调度、因果关系和失败传播，不自动推导处理链。
4. **#41 Selector、Prompt 与 Memory**
   - Selector 通过显式信息引用选择上下文。
   - Prompt provenance 和 Memory 都建立在信息原子与账本之上，不恢复隐式分组。
5. **#42 PostgreSQL 切换**
   - 在存储抽象和账本语义稳定后，将事实存储切换到 PostgreSQL。
   - 保持信息 ID、Kind、引用和投影语义不变。

## 当前约束

- 暂时保留 `messageId`、`eventId`、`traceId`、Web `requestId` 和 Web `sessionId`，
  后续 Issues 再按信息原子和 DAG 契约收敛。
- Web `sessionId` 是过渡性的 metadata-only 会话键：只存于 `messages.metadata_json`
  （无新列、无迁移），供会话查询接口全表 `json_extract` 扫描。它是 Web 入口的限定
  例外，不参与平台分组语义；#38+ 信息原子落地后预期与 `requestId` 一起收敛。
  未来可考虑生成列索引替代全扫描（需数据库迁移，当前不做）。
- 平台 sender、group、平台 message ID 只属于来源和投递信息，不作为 Core 分组键。
- 当前没有持久事件队列、自动重试、去重、热更新、模块沙箱或旧 Memory 占位工作流。
- 新能力必须继续遵守严格 schema、因果链保护、Prompt provenance、结构化日志脱敏
  和启动失败无副作用的边界。

## 验收基线

- 重复、乱序和失败处理不会产生未审计的业务副作用。
- 任一输出都能通过信息引用与因果边追踪到输入。
- 日志和投影不包含 provider 凭据、消息正文或未授权敏感内容。
- PostgreSQL 切换前必须有同一套存储契约测试覆盖 SQLite 与目标实现。
