# Heartflow

## 目的与非目标

协调在线 Agent 回合的可靠推进；不实现具体注意评分、消息正文生成或平台发送；在 eligible 门控之后调用独立 Planner Model Task。

## 消费和产生

消费 candidate、身份终态、注意决策及宿主终态，产生 claim、冻结 context、分派请求和 turn terminal。

## 数据流与边界

使用 scope generation、identity barrier 和 `asOf` Selector 冻结回合。Attention Arousal 只负责必要性门控：`attend` 表示 eligible。只有 eligible turn 创建 `agent.turn.plan` v1（object、light tier）任务。Planner Prompt 读取 Agent 身份、规划规则、同范围历史（assistant 必须成功投递）、冻结记忆和完整 turn；私聊、@ 与回复机器人通过正常硬门禁后进入 Planner，仍允许选择 silent。

## Settings

配置机器人名称、群聊/直接会话频率、mute 和 stale 界限。Planner 使用共享 Agent 身份和宿主授权的 light 模型，无需新增实例配置。

## 可靠性、幂等和失败行为

每个 candidate 只有一个 claim 和 turn terminal。eligible 门控使用 `agent.turn.attention` 命名空间，非 eligible 门控直接提交廉价等待或静默决策；Planner 终态 `agent.turn.plan.completed` 和候选替代共用 `agent.turn.decision` 锁，只有获胜结果可以分派。重放复用通用 Model Task 的持久化请求与终态，以及按 claim 的动作幂等键。重启后 durable 订阅恢复，迟到结果不能越过 supersession。

Planner failed、cancelled、非法 JSON 或 schema 错误均正常提交 `silent: planner-unavailable`，不回退 message、不生成 turn.failed。持久化自身不可用时交由 durable runner 重试，不能将尚未提交的模型结果当作成功。

wait 复用 `agent.wait.requested`，始终 `wakeOnMessage=true`。新消息合并旧输入并携带累计 attempt；重启恢复或定时唤醒后重新执行门控和 Planner。门控等待与 Planner 等待共享最多三次总预算，耗尽后的 wait 变为 `silent: wait-budget-exhausted`。

## 日志与可观测性

记录 context、claim、规划动作及枚举原因、waiting、silent、completed、failed 和 superseded 生命周期。普通日志不包含完整 Prompt 或原始模型输出。

## 典型场景

Planner 只允许以下严格 JSON，不允许额外字段、消息正文或平台目标：

- `message`：`reason` 为 `respond` 或 `contribute`；创建一次当前会话 Message Intent，再调用一次 Composer。
- `wait`：`reason` 为 `await-more-context` 或 `avoid-interruption`；`waitSeconds` 为 5–120 的整数。
- `silent`：`reason` 为 `no-response-needed`、`already-addressed` 或 `avoid-interruption`；不调用 Composer 或投递。

不 eligible 的门控 `defer` 保留廉价 Heartbeat 重判；`ignore` 正常结束。离线 `pnpm prompt:test` 使用真实 Planner 编译器验证结构与字段限制，不调用外部模型。
