# Message Composer

## 目的与非目标

在 Heartflow 已决定发送消息后，根据完整冻结 turn 编写一条自然消息。模块不选择发言时机、不执行 Planner，也不检索跨会话目标。

## 消费和产生

消费 `agent.message.intent.requested` 与 `agent.message.compose` 的 Model Task 完成事实，产生 assistant text 和 delivery request。默认定义 ID 为 `agent.message-composer`，实例为 `message-composer.default`，Prompt kind 为 `message`。

## 数据流与边界

意图严格包含 `target: { adapterId, platform, destination }`、必填 turn provenance 和 `memoryInformationIds`，并可包含 `replyToInformationId`。回复目标只能由 Heartflow 从本轮 `turn-input-N` 映射为 Information ID，意图通过 `agent:reply-to` 显式引用对应入站事实；模型与普通日志看不到平台消息 ID。Selector 沿引用重载冻结 context 及其全部输入，并验证回复事实属于当前冻结回合且目标会话一致。Composer 使用整个 `turn.inputs`，不会把最后一条输入标成必须回答的目标消息。

历史只纳入同范围入站及已成功投递的 assistant；Memory 必须来自意图明确列出的冻结引用。引用机器人消息时，Selector 通过同目标的成功投递回执追溯 assistant 原子，并把回执与因果链保留为引用溯源；晚于冻结时点的回执、失败投递和歧义结果不会用于解析。普通插话产生 `kind: "text"`；合法的显式回复目标在投递前才解析为 `kind: "reply"` 与 `replyToPlatformMessageId`。缺失、越界或跨会话引用会被拒绝，投递地址始终来自意图 target。

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

群聊中多条输入在同一 turn 冻结后，Heartflow 创建一个当前群聊消息意图。Composer 结合全部发言生成一条自然消息；Planner 普通插话时 OneBot action 只包含 text segment，选择某个 `turn-input-N` 时才生成对应 reply segment。入站消息自身带有引用标记只作为理解上下文，不会自动改变回复形态。

## 自然语言跨会话与背景

普通回复的 Prompt 也包含宿主冻结的当前会话名称、发言人显示名、身份状态和本轮关系。背景投影与目标解析投影分离，正文模型不会获得跨会话候选引用或无关目标 ID。自动跨会话意图由 Runtime 提供隔离的发送要求与背景，不加载其他会话正文或来源群历史/Memory；宿主绑定生成的唯一 assistant 正文后，由统一 delivery 链完成最终出站检查。管理端发起的请求继续沿用正文确认流程。
