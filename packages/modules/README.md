# `@kaguya/modules`

## 一方模块目录

每个受信的一方模块放在 `src/first-party/<module>/index.ts`，测试与模块放在同一目录。多个模块共享的 Information Kind 统一定义在 `src/first-party/information-kinds.ts`；只服务于回复模块的上下文辅助代码放在 `src/first-party/message-composer/`。包根 `src/index.ts` 负责稳定的公共导出，调用方不应依赖这些内部路径。

`src/first-party/catalog.ts` 必须显式导入并注册每一个受信模块。Runtime 不扫描目录，也不会因为新增一方文件而自动发现或激活模块。Manifest 的 `consumes` 与 `produces` 是 Runtime 收集模块 Kind 的唯一接口；Runtime、Engine 与 Scheduler 只单独注册自身拥有的基础 Kind。

protocol v2 模块 Manifest 必须提供非空的 `displayName`、单行 `summary` 与完整 `description`。每个 Information Kind 和 Prompt renderer 继续提供非空的 `displayName` 与 `description`；renderer 还要声明稳定 `rendererId` 及适用的 `kinds`。Inspection 和后续 WebUI 直接使用这些字段，不能另行硬编码模块名称。

## 模块文档索引

每个一方模块的相邻 README 是完整说明的唯一事实来源：

- [Attention Arousal](./src/first-party/attention-arousal/README.md)
- [Heartbeat](./src/first-party/heartbeat/README.md)
- [Heartflow](./src/first-party/heartflow/README.md)
- [Identity](./src/first-party/identity/README.md)
- [Association](./src/first-party/association/README.md)
- [Message Composer](./src/first-party/message-composer/README.md)
- [Person Fact Task](./src/first-party/person-fact-task/README.md)

## Heartbeat 与 Heartflow

`heartbeatModule`（定义 ID：`agent.heartbeat.short`）依赖 `oneShotScheduleCapability`，消费 inbound text、`agent.wait.requested` 和 one-shot due，产生 heartbeat schedule/terminal 以及 `agent.turn.candidate`。`createHeartflowModule()` 使用 scope generation、identity barrier 和不可变多输入 context，把 Attention Arousal 的 `attend | defer | ignore` 推进为 message intent、wait 或 silent，并为每个 turn 提交唯一终态。

`createFirstPartyModuleActivations("production")` 使用 1500 ms 去抖，`"test"` 使用 0 ms；两种 profile 都启用 Heartbeat 与 Heartflow。Heartbeat payload 使用绝对时间和稳定 destination scope。消息延期通过 one-shot replacement 合并，进程重启由 durable scheduler 恢复。

默认 Catalog 不含 always-reply 或 inbound-to-context 旁路。Message Composer 当前只接收 Heartflow 的 `attend` 临时桥接，并沿 turn provenance 把 delivery terminal 交回 Heartflow 完成回合。

## Prompt 模板

所有一方模块的可编辑 Prompt 都保存在 `templates/`：`*.default.hbs` 是提交到 GitHub 的默认模板，同名 `*.local.hbs` 是 Git 忽略的本地覆盖。范围包括 Message Composer 的主模板、bootstrap 表达、消息与记忆排版、会话场景、积压提示、人物背景、表达参考和授权正文，Heartflow Planner、bootstrap 策略、Expression 的学习与选择，以及人物事实提取；没有模型指令的模块不需要占位模板。

persona 只定义 Agent 自身身份与性格。人物、关系、会话历史和世界背景必须来自带 Information 引用的冻结证据。Memory、Knowledge、Association 或人物事实提取返回空结果或失败时，下游保持未知，不能把缺失证据改写为事实。

在仓库根目录运行 `pnpm prompt:init`，可为所有已声明模板创建缺失的 local 副本；已有 local 保持原样。也可以只复制需要修改的 default 文件。加载时优先使用 local，仅在 local 不存在时读取 default；因此升级默认模板不会覆盖本地定制，已有 local 也不会自动合并上游变化。本地覆盖属于当前工作区，供使用该模板的实例和 Profile 共享。

管理端保存只写 local；恢复默认会删除对应 local，随后使用 default。正常读取和启动不会重新创建 local，保存或恢复均需重启服务后生效。默认文件缺失、选中的模板为空或非法时会明确失败，不回退到代码内置文本。

`src/prompt-declarations.ts` 集中声明模板归属、变量和组成关系，Node composition root 通过 `@kaguya/modules/prompt-templates/node` 读取并校验。模板在模块构造时编译，运行时复用；主入口不导出 Node loader，保持模块渲染边界为纯函数。跨会话授权正文由 composition 注入 Runtime 的渲染器生成，Runtime 只提供冻结说明与背景及其来源引用，不读取模板文件。

## 空上下文与来源约束

第一次收到消息时，Identity 可以建立账号和会话实体，但这只解决稳定寻址，并不证明机器人认识这个人。Planner 与 Composer 的 `context_bootstrap` 变量根据冻结 turn 以及本阶段实际可见的历史、记忆计算：两者都没有时为 `bootstrap`，存在部分上下文时为 `contextual`。这描述的是本轮信息可用性，不能据此声称整个数据库为空、过去从未见面或所有参与者都是熟人。Composer 统计经过字符预算裁剪后真正展示的条目，因此它与 Planner 的计数可能不同。

`participants` 按冻结输入的 `inputIndex` 对应说话者，提供身份解析状态、scope 模式和本轮可见的同账号历史入站数量。账号解析成功、昵称相同、群名、目标目录可达以及机器人自己说过的话，都不能独立证明现实关系或共同经历。角色人设控制表达风格；现实交往事实来自可追溯输入和记忆。用户自述仍按来源陈述理解，来源可追溯不等于语义已被独立核实。

默认 Planner 在有回应需要但缺少关键背景时可以安排坦率说明、自然追问；Composer 按角色语气落实。能直接回答的内容照常回答，对方已说明的信息不重复问，群聊不因空库主动打断，冷启动也不绕过等待预算和发送授权。没有新增世界模型，也没有启动时生成虚构记忆的填库动作。

| 第一方模块                                    | 空上下文时的职责与边界                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Identity                                      | 从实际入站建立账号/会话，保留 unresolved 或 ephemeral 状态；实体存在不等于关系已知。                               |
| Heartbeat、Attention Arousal、Attention Focus | 继续依据真实事件、时序和已提交状态工作；缺少记忆不增加唤醒、关注或强制回复。                                       |
| Heartflow Planner                             | 显式读取证据可用性，在现有参与策略内安排澄清，不能用人设补造话题背景。                                             |
| Message Composer                              | 使用裁剪后的证据状态，缺少相关依据时承认未知；角色、表达习惯和规划指引不能充当事实。授权跨会话正文同样不补造背景。 |
| Association                                   | 召回来源事实，允许空结果或可选失败；没有结果不解释为事实不存在。                                                   |
| Memory Writeback、Memory Index                | 仅持久化或索引真实来源，不制造初始记忆。                                                                           |
| Memory Cognition、Memory Knowledge            | 使用已持久化证据及其范围、时间和来源校验；空输入不凭人设演化人物画像，页面和模型输出不替代原始证据。               |
| Expression                                    | 无候选或证据不足返回空集合；新证据充分时照常学习。习惯仅限定措辞，不能证明关系或事实。                             |
| Person Fact Task                              | 允许 `fact: null` 弃答；非空事实必须是候选原文片段，避免无来源文字入账。摘录仍可能是用户自述，不代表独立确认。     |

冷启动措辞可在 `heartflow.planner.local.hbs`、`message-composer.behavior.local.hbs` 和 `message-composer.local.hbs` 中按角色调整；主模板和 Planner 声明支持 `context_bootstrap`。沿用现有 default/local 机制，不覆盖本地定制。已有 local 不会自动获得新版规则，升级时需自行合入对应 default 的来源约束和变量，或通过管理端恢复默认后重新定制。
