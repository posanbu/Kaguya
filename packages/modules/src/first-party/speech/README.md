# Speech Planner

## 目的与非目标

在必要性门控通过后判断是否发言。独立参考 MaiBot 的行为分层，没有复制其源码；只返回动作和固定原因，不生成回复正文，不改变目标会话。

## 消费和产生

消费 `agent.attention.arousal.completed`。仅 `attend`（旧设计中的 eligible）调用 `core.speech.plan` v1 Model Task；`defer/ignore` 直接转为 `wait/silent`。最终产生 `agent.speech.decision`，由 Heartflow 分派。

## 数据流与边界

`createSpeechModule` 注入宿主 Model Task capability 和身份。Planner 使用 `route` Prompt、`outputMode: object` 和严格判别联合。Prompt 包含身份、判断规则、同范围内已经成功投递的 assistant 历史及入站上下文、冻结记忆、完整当前消息批次和 JSON 字段约束。

`speak` 的 reasonCode 为 `direct-response | answerable-question | useful-contribution | social-response`；`wait` 为 `conversation-incomplete | awaiting-context` 并必须带 5–120 秒的整数 `waitSeconds`（从持久化模型完成时间起算，重放不延长 deadline）；`silent` 为 `not-addressed | no-value | conversation-between-others | duplicate-or-reaction`。私聊、@机器人、回复机器人会进入 Planner，但允许返回 silent。

## Settings

默认 `speech.default` 激活 `agent.speech.planner`，设置 `modelTier: light`、`policyDigest: speech:planner-v1` 和 `settingsDigest: speech:light-v1`。第一版只接受 light；参数位于 first-party activation 配置源，不增加 Profile、API 或 WebUI 字段。宿主为启用的实例独立授予 light tier 审批。

## 可靠性、幂等和失败行为

模型任务与最终决定分别持久化，首次 requested 的 Prompt 和原子选择在重放中复用。最终决定以 claim 为唯一 terminal key；Heartflow 检查 candidate 是否已结束或被 supersede，防止迟到决定重复回复。

等待复用 Heartbeat 的 durable 一次性调度与 `wakeOnMessage=true`，由新消息或到期重新门控、合并未消费输入并规划。门控与 Planner 共用三次总等待预算；预算耗尽后的 wait 收敛为 silent，不创建新调度。

Model Task failed/cancelled、非法 JSON 或不符合 schema 的输出统一以 `planner-unavailable` 静默闭合，不生成 `turn.failed`、assistant 或 delivery，也不回退 speak。宿主关闭、执行租约中断和存储错误交给 durable runner 恢复，不伪装成模型判断。

## 日志与可观测性

普通日志只记录任务 ID、tier、动作、固定 reason code、预算及 digest，不记录模型原始输出或 Planner Prompt。开发者检查 API 的受控信息账本保留任务、上下文及终态引用；显式开启 content detail 日志才可检查完整 Prompt。

## 典型场景

普通群消息先由门控延期聚合；直接消息进入 Planner。选择 speak 才调用一次 Composer；选择 silent 正常结束；选择 wait 保存 durable heartbeat，重启后继续。
