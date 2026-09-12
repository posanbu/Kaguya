# 配置生效：免进程重启方案

issue #125 提出希望保存配置后不再手动重启。当前 Server 在启动时把 selected Profile 分别传给 HTTP、AdapterHost、Runtime、模型解析器和模块配置；单独重新读取 JSON 不能使这些组件一致切换。特别是模型任务可能正在等待外部响应，旧任务的执行租约、输出目标和凭据不应被中途替换。

本次实现保留显式重启行为，并补齐终端操作和新访问链接指引。下面是后续实现的具体契约，尚未提供 HTTP apply 路由或热加载功能。

## 保存与应用分开

保留现有 Profile 保存接口，增加受 Gateway Bearer 认证保护的 `POST /api/v1/configuration/apply`。客户端提交预期 selected Profile ID 和配置 revision；服务端在一个串行应用锁下再次读取，revision 不一致返回 409，避免覆盖另一页面刚保存的选择。revision 应覆盖 Profile 内容和模块配置，不能只依赖 index 的更新时间；API 只返回不透明的版本标识，不返回凭据或原始配置摘要。

接口返回 applied、restart_required 或 failed。状态接口同时返回 selected Profile 和当前生效的 Profile/revision，Web UI 据此显示“已保存，待应用”或“已生效”，不会把落盘成功当作 Runtime 已加载。数据库连接、监听地址、端口、CORS、代理、限流、日志目标或 Web 资源路径变更先返回 restart_required，并列出安全字段名；这些进程资源暂时维持显式重启。

## 应用过程

先读取并校验完整配置、readiness、模型 tier 和模块配置；存在错误时保持现有实例运行。预检只验证结构与可解析性，不能为测试配置发出真实模型请求。模型凭据、人设、Memory、平台连接和白名单变更进入有界切换流程。

切换时暂停所有入站入口，拒绝新消息并给出短暂不可用状态；停止定时任务领取和 durable claim 领取，允许正在执行的任务有界 drain。到期后通过既有 shutdown abort 和 fencing 释放任务，不写业务 cancelled。旧模型任务与已提交投递保持其持久事实，恢复执行继续遵循当前恢复协议；不能重新注册新的业务输入来伪装切换完成。

完全停止旧 AdapterHost 和 Runtime 后，在同一数据库连接之上创建新组合，重新绑定 Web ingress、消息出口及 Inspection 闭包。新 Runtime、适配器和所有绑定都成功后才发布 applied revision 并开放入站。新的 Snapshot 必须整体生效，不能只更换模型解析器而保留旧人设、白名单或 NapCat 凭据。

应用失败时关闭部分创建的新资源，用内存保留的旧 Snapshot 重新创建旧实例；成功恢复后报告 failed，并继续展示旧 applied revision。恢复也失败则进入可诊断的 degraded 状态，保留配置管理入口。不能重用已经 close 的 Runtime/Runner；它们目前是单次生命周期对象。

## 验收边界

验收应覆盖两个并发 apply、保存与 apply 竞争、持续入站期间切换、长模型调用被 drain、未完成 durable task 的恢复、新适配器启动失败、回滚失败以及 HTTP 资源变更要求重启。验证每个消息最多拥有一个业务输入身份，配置管理始终可访问，旧 adapter 不再接受新入站，应用期间凭据不进入日志或 API 响应。

这套契约可以支持“保存并应用”按钮，并保留进程级变更的重启路径。实现之前仍使用 README 的 `Ctrl+C` → `pnpm dev` / `pnpm start` 流程。
