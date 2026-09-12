# Message Composer

## 目的与非目标

在 Heartflow 已决定发送消息后，根据完整冻结 turn 编写一条自然消息。模块不选择发言时机、不执行 Planner，也不检索跨会话目标。

## 消费和产生

消费 `agent.message.intent.requested` 与 `agent.message.compose` 的 Model Task 完成事实，产生 assistant text 和 delivery request。默认定义 ID 为 `agent.message-composer`，实例为 `message-composer.default`，Prompt kind 为 `message`。

## 数据流与边界

意图严格包含 `target: { adapterId, platform, destination }`、必填 turn provenance 和 `memoryInformationIds`。意图不复制源消息正文、源平台消息 ID 或引用标记。Selector 沿引用重载冻结 context 及其全部输入，并验证目标范围与 provenance。Composer 使用整个 `turn.inputs`，不会把最后一条输入标成必须回答的目标消息。

历史只纳入同范围入站及已成功投递的 assistant；Memory 必须来自意图明确列出的冻结引用。引用机器人消息时，Selector 通过同目标的成功投递回执追溯 assistant 原子，并把回执与因果链保留为引用溯源；晚于冻结时点的回执、失败投递和歧义结果不会用于解析。每条入站的引用可作为理解上下文，出站始终是普通 `kind: "text"`，投递地址只来自意图 target。公共 OneBot `kind: "reply"` 能力保留给专用模块。

## Prompt 模板

默认模板位于 `packages/modules/templates/message-composer.default.hbs`。本地覆盖使用同名 `*.local.hbs`，文件被 Git 忽略，Server 重启后重新加载；旧 `llm-reply.*.local.hbs` 不再加载。

模板分为 `message-composer` 外层，以及 `.history`、`.history-inbound`、`.history-assistant`、`.memory`、`.memory-item`、`.quoted`、`.turn`。集合层允许 `each`、`if`、`unless` 和明确声明的静态 partial；动态 partial、递归和自定义 helper 会被拒绝。

外层变量为 `persona`、`name`、`aliases`、`self_account`、`scene`、`history`、`memory`、`turn`。消息层提供 `occurred_at`、`sender_name`、`sender_id`、`platform`、`adapter_id`、`destination`、`message_id`、`mentions`、`reply_to`、`content`、`quoted_message`、`self_account`、`name` 和 `is_assistant`。引用内容属于对应入站的 `quoted_message`，不是全局必须回答的消息。

历史最多 30 条、12,000 个 Unicode code point；Memory 最多 4,000 个 code point。预算在消息渲染后、集合层渲染前执行，完整当前 turn 不受历史预算裁剪。变量可省略或重复使用，provenance 只记录外层实际使用的变量。动态数据不做 XML/HTML 逃逸，模板应明确区分内容与指令。

## Settings

settings 只包含必填的 `modelTier: "light" | "heavy"`。模板和 Agent 身份由 composition root 注入。旧 source/fixed outbound 配置不再有效；升级时备份并重新初始化模块配置。

## 可靠性、幂等和失败行为

稳定任务键复用等价 Model Task；assistant 与 delivery 使用实例级 `registerOnce` 去重。模型 failed/cancelled 不生成 assistant，缺少冻结引用或 provenance 不一致时拒绝继续。旧 reply kind、模块和任务不会获得兼容处理，也不迁移历史原子。

## 日志与可观测性

`message.model.dispatching` 记录任务、模型层级和 Prompt、历史、Memory、turn 的长度指标；普通分派日志不记录完整 Prompt、原始模型输出或凭据。

## 典型场景

群聊中多条输入在同一 turn 冻结后，Heartflow 创建一个当前群聊消息意图。Composer 结合全部发言生成一条自然消息，默认 OneBot action 只包含 text segment，即使某条入站消息带有引用标记。
