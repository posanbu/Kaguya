# Attention Arousal

## 目的与非目标

Arousal 在读取正文前维护机器人唤醒状态并决定是否观察。它不读取入站正文，不判断相关性、话题或参与价值，也不生成回复或执行平台动作。

## 消费和产生

消费不含正文的 `agent.turn.candidate`、全局消息活动、one-shot due 和 Focus 租约投影；产生 `agent.attention.arousal.state.recorded` 与唯一的 `agent.attention.arousal.completed: observe | defer`。

## 数据流与边界

最新注册的 state 事实是唤醒状态真值；缺失时默认 `awake`。私聊、Web、@、回复机器人、有效 Focus 或周期复查会确认 awake 并 observe；awake 下普通机会也 observe。只有 asleep 且没有唤醒信号的普通机会 defer。mute、安全、目标、授权及 `message | wait | silent` 均在 observe 后处理。

## Settings

`idleSleepEnabled` 与 `idleSleepAfterMs` 控制全局无消息休眠，默认关闭和两分钟；`nightSleepEnabled`、`nightSleepStart`、`nightSleepEnd` 控制本地夜间窗口，默认关闭和 23:00–07:00；`periodicWakeEnabled`、`periodicWakeEveryMs` 控制休眠后的周期复查，默认开启和五分钟。

## 可靠性、幂等和失败行为

状态迁移与 timer 以稳定键写入；绝对 one-shot deadline 可在重启后恢复，不使用固定 tick 或心跳计数。`defer` 不创建 turn context、不推进未读水位。旧状态、旧评分 payload 和旧设置由严格 schema 拒绝。

## 日志与可观测性

完成事实只记录 scope、候选与水位、通知信号、Focus 快照、未读数量、唤醒状态、决定原因和策略版本，不记录正文、分数或阈值。

## 典型场景

默认 awake 收到普通群聊会 observe；处于夜间休眠时普通群聊 defer 并继续积攒；@机器人、有效 Focus 或五分钟周期复查会唤醒并观察该 scope 的全部积压。
