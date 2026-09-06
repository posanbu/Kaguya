# Durable Cadence

`@kaguya/scheduler` 提供固定边界的持久化 cadence。每个窗口由
`anchor + windowIndex × intervalMs` 唯一确定，停机期间错过的窗口按
`coalesce.v1` 合并为一个 tick。definition、tick 以及维护请求均通过
Information Atom 保存，并使用 `registerOnce` 防止重复提交。

调度器只负责产生时间事实，不代表维护任务已经成功，也不会唤醒对话
Agent。Runtime 只有在显式传入 cadence 配置时才启动日志投影
reconciliation consumer。
