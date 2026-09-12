# 配置热应用

Web UI 的“保存配置”只写入 Profile，切换 Profile 也只更新选中项，均不会自动触发热重载。设置菜单的“配置生效管理”显示当前选中、当前生效及待应用状态；用户检查后点击“应用当前配置”，才提交当前看到的 revision。文件格式升级也由用户手动完成，服务启动不迁移旧配置。

模型及凭据、生成参数、人设、Memory、NapCat 连接、Gateway Allowlist 和模块实例配置可整体热应用。HTTP 服务、Gateway Token 和数据库连接保持不变。此功能不监听文件变化，也不热更新模块源码；手工修改 Profile 或模块 JSON 后需显式应用。运行中不要手工修改 Registry 索引；Profile 的创建、删除和选择应通过管理接口完成。

## 接口与并发

`GET /api/v1/configuration/status` 和 `POST /api/v1/configuration/apply` 均要求 Gateway Bearer 认证，并返回 `Cache-Control: no-store`。状态包含 `state`（ready、pending、applying、degraded）、`selectedProfileId`、`selectedRevision`、`appliedProfileId` 和 `appliedRevision`；没有可用 Runtime 时最后两项为 null。保存和选择接口也返回同一写锁内捕获的 `application` 快照。

POST 提交 `{ "selectedProfileId": "default", "revision": "<selectedRevision>" }`。revision 是完整 Profile 与模块实例配置经进程私有密钥计算的 HMAC，不暴露凭据摘要；重启后需要重新读取。应用与 HTTP 配置写入共用串行锁。版本过期或另一次应用正在执行时返回 409，客户端刷新状态后由用户确认重试，不自动重新提交。应用期间配置读取和健康检查可用，保存请求排队。

响应中的 `data.status` 为 applied、restart_required 或 failed，并附带实际生效快照。failed 使用固定 `errorCode`，不返回底层错误正文或配置值。配置结构及模型选择预检失败时保持原实例；预检不会发出真实模型请求，也不能保证凭据有效或平台连通。

## 切换与恢复

通过预检后，暂停全部入站，停止调度和 durable claim 领取。Runner 默认允许已领取任务收尾 5 秒，超时再传播 shutdown abort，并有界等待退出；未完成 claim 按既有释放、租约与 fencing 协议恢复，不记录业务取消。忽略 abort 的迟到处理不能越过持久化 fencing 写入输出；这不为第三方已经收到的外部请求提供 exactly-once 保证。

旧 Runtime 与 AdapterHost 关闭后，在同一数据库上创建新实例，绑定消息出口、Web ingress 和 Inspection 服务，再发布生效版本并恢复入口。切换中 Web 消息和 Inspection 返回 503；旧适配器回调保持关闭状态，不能进入新 Runtime。NapCat 使用自己的连接重试机制，“已生效”表示新配置已加载，不表示 QQ 已连接或模型凭据验证成功。

新实例启动失败时清理新资源，并用内存中的旧快照重建旧实例。恢复成功返回 failed，继续显示旧 applied revision，已保存的新配置仍可修改或重试。回滚也失败时进入 degraded，配置管理入口仍可用。若任一实例未能安全关闭，则阻止再次启动，返回 shutdown_failed，需要重启进程，避免存在两个资源所有者。

## 仍需重启的字段

以下 runtime 字段变更返回 restart_required，并仅列出字段名：`host`、`port`、`databaseMode`、`databaseUrl`、`webDistPath`、`corsOrigins`、`trustProxy`、`rateLimitMax`、`rateLimitWindowMs`、`logLevel`、`logFormat`。不做部分应用，原实例继续运行。

在原终端按 Ctrl+C，从仓库根目录执行 `pnpm dev`；生产模式执行 `pnpm start`。重启后打开终端打印的新访问链接。Gateway Allowlist 不在此限制内，可以直接应用。
