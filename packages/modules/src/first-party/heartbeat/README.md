# Heartbeat

## 目的与非目标

可靠地去抖、延期并重新唤醒待处理事件；不判断注意、话题或行动。

## 消费和产生

消费入站文本、`agent.wait.requested` 和 one-shot due，产生 heartbeat 生命周期及 turn candidate。

## 数据流与边界

业务模块决定 dueAt 和聚合输入；Scheduler 只提供 durable one-shot 能力。

## Settings

配置消息去抖、调度替换重试和注意重判总预算。

## 可靠性、幂等和失败行为

同一 scope 的新消息替换开放 schedule，并显式终结旧 heartbeat；进程重启后由 Scheduler 恢复。

## 日志与可观测性

记录 scheduled、fired、superseded、failed 和 source 数量。

## 典型场景

Attention Arousal 返回 `defer` 后，15 秒重新生成携带累计输入的 candidate。
