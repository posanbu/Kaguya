---
title: LLM Prompt 装配与模板原文
description: 查看 Light、Heavy 与结构化输出协议的生产模板，以及最终请求文本的形成方式。
---

# LLM Prompt 装配与模板原文

本页代码块在文档构建时直接读取仓库里的 `.default.hbs` 文件，显示的是生产模板原文，不另存一份副本。修改现有模板正文后，重新构建文档就会显示新内容。仓库源码也可以从 [模块模板目录](https://github.com/posanbu/Kaguya/tree/main/packages/modules/templates)和 [LLM 协议模板目录](https://github.com/posanbu/Kaguya/tree/main/packages/llm/templates)直接打开。

模板中的双花括号标记在每次请求时填入动态变量；`if`、`each` 块控制条件和循环；静态 partial 插入下方对应的子模板。本地 `*.local.hbs` 覆盖可编辑资源时，运行时使用 local 内容，因此某次请求的最终文本应以请求详情中的持久化 Prompt 为准。

当前模板声明包含 Light、Heavy、身份、统一 Memory 和 QQ 表情任务。人物画像与表达习惯共用 Memory 整理模板。

[情境—行动上下文模型](./situation-model/)的公共契约保持 `1.0.0`。默认链由 `agent.situation` 冻结证据和已有行动结果，再依次触发注意模块、Light 和 Heavy。原生消息使用独立的运行时扩展 `version: 1`。

`bootstrap` 保存建档事实，不表示认识程度。`context_bootstrap` 统计实际装配的历史、固定记忆和动态召回。最终预算裁剪后，记忆计数及人物节点关联同步更新。账号解析成功不证明彼此认识，可见历史为空也不证明第一次见面。

情境人物卡片按所选请求中的 `ownerId` 展示 `native_memory.fixed` 原文，并提供背景和证据变量原文。它不读取当前人物图补写旧请求。

## Light：决定是否交给 Heavy

情境运行模块先等待原始 Memory 写入越过本轮账本上界，再冻结 `global_context` 与 `scope_context`。前者包含近十分钟各 scope 的运行事件；后者包含当前 scope 近十分钟、窗口前最近三十条语义事件及全部带“未读”标记的本轮入站原文。两块文本及完整来源 ID 持久化在同一个冻结事实中。Light 还读取身份、选中记忆、平台参与策略、当前会话背景和 `decision_state` 中的动作及等待预算。[变量编译位置](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/router/light.ts)、[原始 Memory 读取](https://github.com/posanbu/Kaguya/blob/main/packages/database/src/raw-event-store.ts)。

冻结事实生成后，注意模块只读取元信息。允许观察时，独立 Router 调用 Light。`defer` 保留未读范围。当前 Light 任务输出 `message | wait | silent` 和结构化原因码。`message` 只附带必要的目标信息，不传话题、回复动作、焦点、语气或写作建议。Model Task 不再保存版本字段；已完成任务的请求仍保留原始 Prompt。

`conversation.resolution.targets` 提供当前 adapter 的有界群名候选及本轮相关私聊。Light 可以根据简称、关键词或描述选择群，不要求输入包含完整群名。`relation=available` 表示目录候选，`status=resolved` 表示宿主核实该候选可用；两者都不证明用户意图。Light 仍须根据请求区分目标，宿主继续复核引用、出站白名单和连接代次。候选目录不包含目标群正文，也不会传给跨会话正文生成任务。

::: code-group

<<< ../../packages/modules/templates/light.decision.default.hbs [Light 主模板 ~~vscode-icons:file-type-handlebars~~]

:::

`bootstrap_policy` 和 `platform_policy` 来自以下模板；平台策略按 QQ、Web 或默认资源选择。

::: code-group

<<< ../../packages/modules/templates/light.bootstrap-policy.default.hbs [冷启动策略 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/light.platform-policy.default.hbs [默认平台 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/light.platform-policy-qq.default.hbs [QQ 平台 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/light.platform-policy-web.default.hbs [Web 平台 ~~vscode-icons:file-type-handlebars~~]

:::

Light 是 `object` Model Task。Runtime 先把任务输出 schema 转为 JSON Schema，将下方协议追加到正文末尾，然后保存 `core.model.task.requested` 并发起模型调用。[协议装配位置](https://github.com/posanbu/Kaguya/blob/main/packages/runtime/src/model-task.ts)。

::: code-group

<<< ../../packages/llm/templates/structured-output-json.default.hbs [JSON Schema 协议 ~~vscode-icons:file-type-handlebars~~]

:::

## Heavy：独立决定普通回复或沉默

Light 选择 `message` 后，Heavy 根据消息意图取得同一个原始 Memory 冻结事实，逐字复用 `global_context` 与 `scope_context`。Light 不生成供 Heavy 使用的情境摘要。新的 `native_memory` 区块承载统一记忆快照，旧人物画像和独立表达选择不再进入新请求。场景和 `conversation.background` 继续描述会话。两块事件文本共以 32,000 字为目标预算；三十条历史保底与未读原文不裁剪。[上下文选择](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/heavy/message-context.ts)、[变量编译](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/heavy/message-prompt.ts)。

以下是 [Heavy 主模板](https://github.com/posanbu/Kaguya/blob/main/packages/modules/templates/heavy.default.hbs)，其中 `behavior_policy`、`platform_style`、`scene`、`bootstrap`、`global_context`、`scope_context`、`memory` 会替换为后续模板渲染结果；`persona`、身份、时间、冻结事实和上下文状态也在请求时填入。新请求没有独立的 `history` 或 `turn` 文本段。

::: code-group

<<< ../../packages/modules/templates/heavy.default.hbs [Heavy 主模板 ~~vscode-icons:file-type-handlebars~~]

:::

### 原生接续与行动结果

Heavy 普通回应任务追加 `action_records`。这些记录来自冻结边界内已保存的模型结果、行动终态和投递回执。装配过程不推断承诺、待办或行动理由。

Model Task 在调用前保存实际 `messages`。请求以同一冻结输入重试。完成后保存服务返回的原生消息、推理项与协议元数据。沉默也保存这些内容。取消或已被替代的结果不进入后续接续。Light 与 Heavy 的记录分开。

LLM 客户端接受文本 `prompt` 或结构化 `messages`，两者互斥。Heavy 接续按原顺序保留兼容模型的原生返回，再附上已记录的执行结果和当前冻结 Prompt。模型身份改变时，只在工具交互闭合后开始新的请求历史。不可读数据保持原形，不转写成正文。

原始证据窗口仍使用既有 32,000 字目标预算。接续另按完整请求的 UTF-8 JSON 字节检查 128,000 字节上限。它是保守容量约束，不是精确 token 计数。先保留未完成行动、等待、未知结果和未配对工具，再选取可容纳的近期闭合片段。必要内容仍超限时记录受阻，不调用摘要模型。原账本记录不删除。

界面只展示服务实际提供的可读推理。没有内容时显示“未提供”。模型错误单独显示，不转换为沉默。

### 行为、平台与场景

`behavior_policy` 来自通用规则；`platform_style` 选 QQ、Web 或默认资源；`scene` 根据群聊/私聊及积压状态渲染；`bootstrap` 表达冻结的可知状态。

::: code-group

<<< ../../packages/modules/templates/heavy.behavior.default.hbs [通用行为 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.platform-style.default.hbs [默认风格 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.platform-style-qq.default.hbs [QQ 风格 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.platform-style-web.default.hbs [Web 风格 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.scene.default.hbs [场景 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.bootstrap.default.hbs [上下文可靠性 ~~vscode-icons:file-type-handlebars~~]

:::

### 原始事件背景与记忆

事件描述由各 Information Kind 专属包装器在冻结时生成；成功投递与失败尝试有不同状态措辞，入站原生回复关系保留在描述中。没有证据链的事件不显示。请求、草稿和模型任务不作为独立背景事件。显式引用的历史消息使用以下模板排版。统一 Memory 由后述快照段注入。

::: code-group

<<< ../../packages/modules/templates/heavy.memory.default.hbs [记忆列表 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.memory-item.default.hbs [单条记忆 ~~vscode-icons:file-type-handlebars~~]

:::

### 条件追加与授权发送

普通回复在有冻结会话背景时，于主模板后追加 `conversation-background`。Light 与普通 Heavy 请求还由宿主强制追加 `native_memory`，包含固定摘要、动态结果、版本和降级信息。固定摘要不占动态召回额度，表达记忆只影响措辞。已获授权的跨会话发送使用独立的 automatic/admin 模板，输入为已批准的 `instruction` 和可用的冻结背景。[分支位置](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/heavy/index.ts)。

::: code-group

<<< ../../packages/modules/templates/heavy.conversation-background.default.hbs [会话背景 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.authorized-automatic.default.hbs [自动授权 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.authorized-admin.default.hbs [管理员授权 ~~vscode-icons:file-type-handlebars~~]

:::

普通回复的 Heavy 任务为 `object` Model Task，返回 `{"action":"message","text":"..."}` 或 `{"action":"silent"}`。选择 silent 时记录事实并结束回合，不创建 assistant 或投递。已授权的跨会话发送使用 `text` 模式。Runtime 核对变量的来源 ID、保存最终 `prompt.text`、模板和 digest；结构化任务追加 JSON Schema 协议，LLM client 使用保存的 `prompt.text` 调用模型。这条 Model Task 路径不另传 `system` 字段。[持久化与调用](https://github.com/posanbu/Kaguya/blob/main/packages/runtime/src/model-task.ts)、[LLM client](https://github.com/posanbu/Kaguya/blob/main/packages/llm/src/client.ts)。

## 查看某一次请求的完整文本

在开发者控制台打开模块的模型请求，进入“完整 Prompt”。那里展示的是该次 `core.model.task.requested` 保存的已渲染文本，经过秘密脱敏；不会用当前模板重新生成。Light 与 Heavy 分别有请求目录。也可使用[单次请求详情 API](../reference/http-api)。

## 修改时保持同步

模板正文直接由上述代码块读取，改动 `.hbs` 后文档构建会自动更新展示。新增、删除或重命名模板，以及修改变量来源、装配顺序、条件追加、授权分支或 Model Task 协议时，同一变更应更新本页的说明、片段列表和链接，并运行 `pnpm --dir docs --ignore-workspace docs:check`。

## 记忆形成模板

`memory.native.form` 从真实来源及已有记忆版本形成修订。正文来自同一 default/local 资源机制，输出仍由来源、作用域、版本和层级规则校验。

::: code-group

<<< ../../packages/modules/templates/memory.native.form.default.hbs [记忆形成与整理 ~~vscode-icons:file-type-handlebars~~]

:::

情境 FAB 直接显示所选请求保存的 `native_memory.fixed`。人物背景、群聊属性、自我认识和表达习惯使用已有固定条目。没有关键词时这些条目仍注入。动态内容在召回区显示，旧请求缺失记录时不从当前图补写。
