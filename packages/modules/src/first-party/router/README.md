# Router

## 目的与非目标

`agent.router` 是独立的 Light 判断模块。它只在 `agent.attention.arousal.completed: observe` 后读取已冻结正文，决定 message、wait 或 silent。`agent.situation` 承接候选认领、证据冻结、接续与回合终态。两个模块复用本目录的装配和生命周期实现。

## 消费和产生

Router 消费 observe 决策及其冻结引用，产生 Light 模型任务。情境运行模块消费 candidate、Identity terminal、Light 结果及宿主投递终态，产生 claim、started、turn context、`agent.situation.frozen`、Focus opened、消息意图、wait 请求和唯一 turn terminal。

## 数据流与边界

情境运行模块按 candidate 的排他下界和包含式上界查询最多 1000 条同 scope 入站，等待每条 Identity terminal，再一次性冻结上下文。晚到时间戳不能越过注册水位，上界后的新消息留给下一次观察。冻结完成后依次触发注意模块与 Light。`defer` 保留冻结记录，但不推进未读水位。

冻结后才执行 mute、安全、目标和授权检查。Light 判断参与价值并选择 `message | wait | silent`；`message` 只传目标和冻结引用，不传生成的话题、焦点、回复动作或写作建议。Heavy 读取同一份冻结 turn，独立决定发言或沉默。群聊直接通知在 observe 后开启 Focus；成功投递续租，silent/failed 关闭，wait 保持自然到期。

bootstrap 版本 2 仅保存人物及会话的建档来源、时间和是否由本轮输入创建，不推断认识程度。context_bootstrap 在最终 Prompt 装配时统计历史、固定记忆及动态召回，并关联人物节点。Light 与 Heavy 复用同一回合的记忆版本。

## 规划上下文与回复兴趣

记忆查询从最近八条不同的非空输入分配最多 512 字，长消息同时保留首尾。sparse 原文与至多两条认知快照合并，总数不超过八条；来源受范围和时间截止点约束。

回复兴趣来自已入库且本次召回的原文，不新增自动判定兴趣的打分器；没有证据则保持未知。

Light 的每条冻结输入包含稳定的 `speakerKey`、平台消息标识、直接通知事实和经宿主核验的 `quotedMessage`。引用通过同会话、截止时间和成功投递链验证；缺失或冲突时显式标为 `unavailable`，不会猜测正文。历史与记忆分别限制为 12000 字和 4000 字：历史优先保留最新内容，记忆按已选来源平均分配配额并标记裁剪；本轮输入保持完整，引用链保留原始 ID 溯源。模型按对话对象、表达完整性和新增交流价值决定是否参与，不因其他人的未完表达阻塞一个独立完整的直接问题。

`agent.light.decide` v3 模型任务在等待预算耗尽时移除 wait 分支。非法输出先经过一次结构修复，仍不合法则记录模型失败；不会登记非法消息意图或第四次等待。旧版任务按持久化 schema 和 Prompt 重放。

## Settings

`muted` 在 observe 后抑制主动回复；`focusIdleMs` 管理 Focus 租期；`staleAfterMs` 标记积压供 Light 判断；`lightInterruptMaxConsecutiveCount` 限制同轮重规划。`light.bootstrap-policy` 是独立可编辑的 Light 策略。旧称呼、频率和 Arousal 评分设置已删除。

## 可靠性、幂等和失败行为

claim、context、Light decision 和 terminal 使用稳定键与排他槽。重复 candidate、重复 delivery、进程重启和旧代际 one-shot 不会创建第二个有效 turn；身份未完成时保持开放，身份耗尽、授权失败或目标不可用时 fail-closed。`observedThroughInformationId` 记录冻结范围，只有对应注意决策为 observe 时才推进已观察水位。

Light failed、cancelled、非法输出或模型不可用记录为失败，不显示为 silent。Light wait 使用独立 `totalWaitBudget`；Arousal defer 不消耗预算。Heavy 首次选择 silent 时记录 `heavy-declined` 终态。逐段表达的中间投递不结束 turn，最后一段成功投递才完成。已经发送部分内容后选择 silent，保留成功回执并记为 completed。重试复用调用前已持久化的完整输入及原生消息，supersession 后的迟到结果不能派发。

## 日志与可观测性

记录 claim、context、水位、bootstrap、规划动作、waiting、silent、completed、failed、interrupted 和 superseded 生命周期。普通日志不包含完整 Prompt、原始模型输出或未观察正文。

## 典型场景

先冻结该 scope 的全部有界未读，注意模块允许 observe 后再由 Light 选择 message、wait 或 silent。直接群聊输入可开启 Focus，但仍允许 Light silent；跨会话目标必须通过宿主授权复核。超大积压按 1000 条上限自然分批，不跳过水位。

## Focus 租约

Focus 是情境运行模块维护的持久化会话租约，不设独立模块实例。它在群聊直接通知完成 observe 后登记 `agent.router.focus.opened`；成功投递续租，silent 或 failed 关闭，wait 保持至自然到期。Arousal 通过 Router 提供的只读 Selector 获取当时有效的租约，私聊不创建租约。

每个 grant 有独立 generation 和 durable 到期调度。开启、续租和终态按稳定来源去重；旧代际到期不能关闭新租约。进程重启后由账本和 Scheduler 恢复。Inspection 通过 caused-by、uses-context 和 status-of 展示生命周期、来源和到期时间。
