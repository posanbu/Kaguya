# LLM Reply

## 目的与非目标

根据明确选择的冻结上下文生成一次回复；不决定事件是否值得注意，也不承担通用规划。

## 消费和产生

消费 `core.reply.requested` 和 Model Task 终态，产生 Model Task 请求、assistant text 与 delivery request。

## 数据流与边界

Prompt 只包含 Selector 授权并带 variable provenance 的上下文。模块把原子渲染为 `scene`、`history`、`memory`、`quoted` 和 `target` 变量，最终排版完全由文本模板决定；模型调用由 Runtime Model Task 执行。

## Prompt 模板

默认模板位于 `packages/modules/templates/llm-reply.default.hbs`。需要本地自定义时，复制任意 `*.default.hbs` 为对应的 `*.local.hbs` 并重启 Server；local 文件已被 Git 忽略。

Reply 使用外层、集合层和消息层模板：`llm-reply`、`llm-reply.history`、`llm-reply.history-inbound`、`llm-reply.history-assistant`、`llm-reply.memory`、`llm-reply.memory-item`、`llm-reply.quoted` 与 `llm-reply.target`。历史和 Memory 集合可用内建 `each`、`if`、`unless` 及模板声明的静态 partial；不支持动态 partial、递归 partial、任意文件 include 或业务 helper。

外层变量为 `persona`、`name`、`aliases`、`self_account`、`scene`、`history`、`memory`、`quoted`、`target`，可不出现或重复出现；provenance 只记录实际使用的外层变量。消息模板提供 `occurred_at`、`sender_name`、`sender_id`、`platform`、`adapter_id`、`destination`、`message_id`、`mentions`、`reply_to`、`content`、`self_account`、`name` 和 `is_assistant`。模板替换不做 XML 或 HTML 逃逸，动态数据的标题、分隔符和安全边界由模板作者负责。

## Settings

配置模型层级和出站消息模式。Prompt 模板由 composition root 从模块模板目录读取后注入，不进入实例 settings。

## 可靠性、幂等和失败行为

稳定任务键复用等价 Model Task；失败显式落账且不伪造 assistant 输出。

## 日志与可观测性

记录模型分派和输出生命周期，日志投影不包含凭据。

## 典型场景

Heartflow 将 `attend` 临时桥接为回复请求后，生成并发送文本回复。
