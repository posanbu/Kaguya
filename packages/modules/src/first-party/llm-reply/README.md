# LLM Reply

## 目的与非目标

根据明确选择的冻结上下文生成一次回复；不决定事件是否值得注意，也不承担通用规划。

## 消费和产生

消费 `core.reply.requested` 和 Model Task 终态，产生 Model Task 请求、assistant text 与 delivery request。

## 数据流与边界

Prompt 只包含 Selector 授权并带 provenance 的上下文片段，模型调用由 Runtime Model Task 执行。

## Settings

配置模型层级和出站消息模式。

## 可靠性、幂等和失败行为

稳定任务键复用等价 Model Task；失败显式落账且不伪造 assistant 输出。

## 日志与可观测性

记录模型分派和输出生命周期，日志投影不包含凭据。

## 典型场景

Heartflow 将 `attend` 临时桥接为回复请求后，生成并发送文本回复。
