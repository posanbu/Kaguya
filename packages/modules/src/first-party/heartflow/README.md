# Heartflow

## 目的与非目标

Heartflow 只在 `agent.attention.arousal.completed: observe` 后读取正文，协调候选认领、上下文冻结、Planner 和回合终态。它不实现注意评分、消息正文生成或平台传输。

## 消费和产生

消费 candidate、observe 决策、Identity terminal、冻结 context、Planner 结果及宿主投递/失败终态；产生 claim、started、完整 turn context、Focus opened、消息意图、wait 请求和唯一 turn terminal。

## 数据流与边界

Heartflow 按 candidate 的排他下界和包含式上界查询最多 1000 条同 scope 入站，等待每条 Identity terminal，再一次性冻结上下文。晚到时间戳不能越过注册水位，上界后的新消息留给下一次观察。`defer` 不产生 claim 或 context。

冻结后才执行 mute、安全、目标和授权检查。Planner 独占相关性、话题选择、参与价值及 `message | wait | silent`。群聊直接通知在 observe 后开启 Focus；成功投递续租，silent/failed 关闭，wait 保持自然到期。

bootstrap 只依据冻结输入、身份实体创建来源和本轮授权 Memory，区分 `cold-start`、`warming`、`established`；缺少字段的旧事实仅归一为保守的 `legacy-unknown`。版本化投影和身份实体证据随 turn 冻结，不由后续消息或 Memory 改写。

## Settings

`muted` 在 observe 后抑制主动回复；`focusIdleMs` 管理 Focus 租期；`staleAfterMs` 标记积压供 Planner 判断；`plannerInterruptMaxConsecutiveCount` 限制同轮重规划。`heartflow.bootstrap-policy` 是独立可编辑的 Planner 策略。旧称呼、频率和 Arousal 评分设置已删除。

## 可靠性、幂等和失败行为

claim、context、Planner decision 和 terminal 使用稳定键与排他槽。重复 candidate、重复 delivery、进程重启和旧代际 one-shot 不会创建第二个有效 turn；身份未完成时保持开放，身份耗尽、授权失败或目标不可用时 fail-closed。只有完整 context 成功冻结后才记录 `observedThroughInformationId`。

Planner failed、cancelled、非法输出或模型不可用会安全降级为 silent。Planner wait 使用独立 `totalWaitBudget`；Arousal defer 不消耗预算。重放复用已持久化 Prompt 和上下文，supersession 后的迟到结果不能派发。

## 日志与可观测性

记录 claim、context、水位、bootstrap、规划动作、waiting、silent、completed、failed、interrupted 和 superseded 生命周期。普通日志不包含完整 Prompt、原始模型输出或未观察正文。

## 典型场景

observe 后冻结该 scope 的全部有界未读，再由 Planner 选择 message、wait 或 silent。直接群聊输入可开启 Focus，但仍允许 Planner silent；跨会话目标必须通过宿主授权复核。超大积压按 1000 条上限自然分批，不跳过水位。

## 破坏式协议

旧 turn context、candidate、Arousal payload 和模块配置必须重置；仓库不提供 legacy union、双读或迁移分支。
