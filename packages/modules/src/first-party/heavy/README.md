# Heavy

## 目的与非目标

在 Router 选择把回合交给 Heavy 后，根据完整冻结 turn 独立决定发言或保持沉默。发言可以逐段生成，每段成功投递后再接续。模块不执行 Light，也不检索跨会话目标。

## 消费和产生

消费 `agent.router.message.intent.requested` 与 `agent.heavy.respond` 的 Model Task 完成事实；普通回复可产生 assistant text 和 delivery request，或 `agent.heavy.response.silent`。默认定义 ID 为 `agent.heavy`，实例为 `heavy.default`，Prompt kind 为 `message`。

## 数据流与边界

新意图严格包含 `target: { adapterId, platform, destination }`、必填 turn provenance 和 `memoryInformationIds`。旧意图中的 `composition` 仍可解析以支持重放，但不再进入 Heavy Prompt。意图不复制源消息正文、源平台消息 ID 或引用标记。Selector 沿引用重载冻结 context 及其全部输入，并验证目标范围与 provenance。Heavy 使用整个 `turn.inputs`，不会把最后一条输入标成必须回答的目标消息。

历史只纳入同范围入站及已成功投递的 assistant。统一 Memory 使用该回合冻结的固定摘要和动态召回，作为 `native_memory` 数据段注入。显式历史消息引用仍须来自意图列出的来源。引用机器人消息时，Selector 通过同目标的成功投递回执追溯 assistant 原子，并把回执与因果链保留为引用溯源；晚于冻结时点的回执、失败投递和歧义结果不会用于解析。每条入站的引用可作为理解上下文，出站始终是普通 `kind: "text"`，投递地址只来自意图 target。公共 OneBot `kind: "reply"` 能力保留给专用模块。

## Prompt 模板

默认模板位于 `packages/modules/templates/heavy.default.hbs`。本地覆盖使用同名 `*.local.hbs`，文件被 Git 忽略，Server 重启后重新加载；旧 `llm-reply.*.local.hbs` 不再加载。

模板分为 `heavy` 外层，以及 `.bootstrap`、`.history-inbound`、`.history-assistant`、`.memory`、`.memory-item`、`.scene` 等当前生效的资源。`.history-inbound` 和 `.history-assistant` 用于显式历史消息引用。原始事件背景与统一记忆快照分别保留来源和版本。集合层允许 `each`、`if`、`unless` 和明确声明的静态 partial；动态 partial、递归和自定义 helper 会被拒绝。

外层变量包含 `context_bootstrap`、`bootstrap`、`persona`、`name`、`aliases`、`self_account`、`scene`、`history`、`memory` 和 `turn`。消息层提供 `occurred_at`、`sender_name`、`sender_id`、`platform`、`adapter_id`、`destination`、`message_id`、`mentions`、`reply_to`、`content`、`quoted_message`、`self_account`、`name` 和 `is_assistant`。引用内容属于对应入站的 `quoted_message`，不是全局必须回答的消息。

`.bootstrap` 把 Router 已冻结的可知状态转为自然表达约束。`context_bootstrap` 另行说明经过历史与 Memory 预算后真正展示给 Heavy 的证据数量。Heavy 可以承认当前不知道某个人或会话背景，但不能把未知写成否定事实，也不能用 persona 补齐外部关系和共同经历。

只有冻结 turn 被标记为积压时，`scene` 才补充首末输入年龄，并提示 Heavy 按语境决定是否自然承接迟到；不会强制道歉或说明系统恢复。实时回合的 `scene` 不变。

历史最多 30 条、12,000 个 Unicode code point；Memory 最多 4,000 个 code point。预算在消息渲染后、集合层渲染前执行，完整当前 turn 不受历史预算裁剪。变量可省略或重复使用，provenance 只记录外层实际使用的变量。动态数据不做 XML/HTML 逃逸，模板应明确区分内容与指令。

运行时另行装配冻结的 `action_records` 和原生消息。行动记录只反映已登记状态与实际回执，不在调用前推断待办、承诺或理由。原生历史的预算包含全部消息，并以完整交互为裁剪单位。

## Settings

原有 settings `{}` 继续有效。可选 `pacing` 配置提供 `baseMs: 150`、`perCharacterMs: 25`、`minMs: 200` 和 `maxMs: 1200`。模拟耗时为 `(baseMs + perCharacterMs × Unicode code point 数) × 抖动系数`，随后限制在最短和最长时间之间。抖动系数为 0.85–1.15，由步骤身份稳定确定。计时从模型请求开始，生成超过目标时长后不再增加等待。模型固定使用 Profile 的 `heavy` 档位。

## 可靠性、幂等和失败行为

普通回复使用结构化输出：`message(text, continuation)`、`silent` 或 `recall(query, candidateIds)`。`continuation` 是简短的未完成表达意图，`null` 表示本条投递后结束。旧输出缺少该字段时仍按单条消息处理。silent 不要求另写理由。授权跨会话发送使用文本输出。稳定任务键复用等价 Model Task；assistant、silent 与 delivery 使用实例级 `registerOnce` 去重。silent 不生成用于投递的 assistant 原子，由情境运行模块关闭回合。模型任务仍保存服务实际返回的原生消息、推理项和协议元数据，后续调用按兼容协议接续。界面缺少可读推理时显示“未提供”。模型 failed/cancelled 不生成 assistant，缺少冻结引用或 provenance 不一致时拒绝继续。

## 日志与可观测性

`heavy.model.dispatching` 记录任务、模型层级和 Prompt、历史、Memory、turn 的长度指标；普通分派日志不记录完整 Prompt、原始模型输出或凭据。

## 典型场景

群聊中多条输入在同一 turn 冻结后，Router 创建一个当前群聊消息意图。Heavy 结合全部发言，判断是否仍值得回应；发言时只完成一次自然交流动作，可按语境使用短句，也不设固定字数上限。默认 OneBot action 只包含 text segment，即使某条入站消息带有引用标记。

## 自然语言跨会话与背景

普通回复的 Prompt 也包含宿主冻结的当前会话名称、发言人显示名、身份状态和本轮关系。背景投影与目标解析投影分离，正文模型不会获得跨会话候选引用或无关目标 ID。自动跨会话意图由 Runtime 提供隔离的发送要求与背景，不加载其他会话正文或来源群历史/Memory；宿主绑定生成的唯一 assistant 正文后，由统一 delivery 链完成最终出站检查。管理端发起的请求继续沿用正文确认流程。

## 逐段表达与插话

QQ 群聊、私聊和 Web 普通聊天共用逐段流程。初次发言经过 Light，接续直接调用 Heavy。不设固定消息条数上限，模型按语气和意思分段，需要对方回答时结束。每段增加一次 Heavy 调用。

默认 Prompt 要求独立的回应、解释和追问优先分条，即使总字数较少。只有一个意思时仍可单条结束。缺少当前话题的关键背景时允许自然问清，角色设定不能用于补造现实日程。分段由模型决定，这些要求不保证每次生成都符合预期，需要结合实际投递记录检查。

`agent.heavy.message.ready` 保存最终正文和发送期限，one-shot 调度器负责到期释放。`core.delivery.delivered` 只在本段仍有 continuation 时触发 `agent.heavy.step.requested`。下一步保存原意图、步骤序号、冻结上下文、未完成意图、新输入及此前每段实际回执。成功处理后通过 `agent.heavy.step.observed` 推进观察水位。冻结和失败不推进水位。

正在生成或等待发送的当前段通常发完。新消息进入下一段，包括停止请求。Heavy 通常承接普通插话，按更正调整后文，按停止请求结束。未处理的新消息仍由 Heartbeat 接收。接续选择 silent 时，如果已经发送过消息，整个表达记为 completed，保留最后一次成功回执。

每段有独立模型任务和投递身份，重复回执和重启不会创建重复接续步骤或重复投递。投递失败或结果未知会停止自动接续，保留已发部分。模型超时和上下文预算受阻仍按失败处理。已批准的跨会话单次发送维持原授权边界，不自动接续。

## 持久化记忆补查

Heavy 声明可选的 `memory:native` 依赖。普通回复可以请求补查，授权跨会话正文仍保持单次文本生成。请求和结果分别保存为 `agent.heavy.recall.requested` 与 `agent.heavy.recall.completed`。结果冻结后才再次调用模型，重放复用该结果。失败和关闭状态也进入结果记录，不能被解释为此前没有发生过交流。

范围和时间由原始 `native_memory` 决定。候选 ID 必须已经出现在本轮可见记录中，检索不能创建人物绑定。`memory_recall` 保存本次表达的结果与剩余额度，接续继承，默认最多两次。检索不会生成待发消息、提交回合终态或推进观察水位。最终回复和投递继续使用原意图和原接续步骤。
