---
title: LLM Prompt 装配与模板原文
description: 查看 Light、Heavy 与结构化输出协议的生产模板，以及最终请求文本的形成方式。
---

# LLM Prompt 装配与模板原文

本页代码块在文档构建时直接读取仓库里的 `.default.hbs` 文件，显示的是生产模板原文，不另存一份副本。修改现有模板正文后，重新构建文档就会显示新内容。仓库源码也可以从 [模块模板目录](https://github.com/posanbu/Kaguya/tree/main/packages/modules/templates)和 [LLM 协议模板目录](https://github.com/posanbu/Kaguya/tree/main/packages/llm/templates)直接打开。

模板中的双花括号标记在每次请求时填入动态变量；`if`、`each` 块控制条件和循环；静态 partial 插入下方对应的子模板。本地 `*.local.hbs` 覆盖可编辑资源时，运行时使用 local 内容，因此某次请求的最终文本应以请求详情中的持久化 Prompt 为准。

当前模板声明包含 Light、Heavy、身份、表达与人物事实等仍在使用的任务；主动记忆录入模板已随对应模块移除。

## Light：决定是否交给 Heavy

Router 先等待原始 Memory 写入越过本轮账本上界，再冻结 `global_context` 与 `scope_context`。前者包含近十分钟各 scope 的运行事件；后者包含当前 scope 近十分钟、窗口前最近三十条语义事件及全部带“未读”标记的本轮入站原文。两块文本及完整来源 ID 持久化在同一个冻结事实中。Light 还读取身份、选中记忆、平台参与策略、当前会话背景和 `decision_state` 中的动作及等待预算。[变量编译位置](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/router/light.ts)、[原始 Memory 读取](https://github.com/posanbu/Kaguya/blob/main/packages/database/src/raw-event-store.ts)。

当前 Light 任务输出 `message | wait | silent` 和理由；`message` 只附带必要的目标信息，不传话题、回复动作、焦点、语气或写作建议。Model Task 不再保存版本字段；已完成任务的请求仍保留原始 Prompt。

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

Light 选择 `message` 后，Heavy 根据消息意图取得同一个原始 Memory 冻结事实，逐字复用 `global_context` 与 `scope_context`。Light 生成的表达计划不会进入 Heavy Prompt。独立 `memory`、人物资料、场景和 `conversation.background` 保持原职责。两块事件文本共以 32,000 字为目标预算；三十条历史保底与未读原文不裁剪。[上下文选择](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/heavy/message-context.ts)、[变量编译](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/heavy/message-prompt.ts)。

以下是 [Heavy 主模板](https://github.com/posanbu/Kaguya/blob/main/packages/modules/templates/heavy.default.hbs)，其中 `behavior_policy`、`platform_style`、`scene`、`bootstrap`、`global_context`、`scope_context`、`memory` 会替换为后续模板渲染结果；`persona`、身份、时间、冻结事实和上下文状态也在请求时填入。新请求没有独立的 `history` 或 `turn` 文本段。

::: code-group

<<< ../../packages/modules/templates/heavy.default.hbs [Heavy 主模板 ~~vscode-icons:file-type-handlebars~~]

:::

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

事件描述由各 Information Kind 专属包装器在冻结时生成；成功投递与失败尝试有不同状态措辞，入站原生回复关系保留在描述中。没有证据链的事件不显示。请求、草稿和模型任务不作为独立背景事件。独立记忆仍使用以下模板。

::: code-group

<<< ../../packages/modules/templates/heavy.memory.default.hbs [记忆列表 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.memory-item.default.hbs [单条记忆 ~~vscode-icons:file-type-handlebars~~]

:::

### 条件追加与授权发送

普通回复在有冻结会话背景时，于主模板后追加 `conversation-background`；有表达选择时继续追加 `expression-habits`。已获授权的跨会话发送使用独立的 automatic/admin 模板，输入为已批准的 `instruction` 和可用的冻结背景。[分支位置](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/heavy/index.ts)。

::: code-group

<<< ../../packages/modules/templates/heavy.conversation-background.default.hbs [会话背景 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.expression-habits.default.hbs [表达习惯 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.authorized-automatic.default.hbs [自动授权 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heavy.authorized-admin.default.hbs [管理员授权 ~~vscode-icons:file-type-handlebars~~]

:::

普通回复的 Heavy 任务为 `object` Model Task，返回 `{"action":"message","text":"..."}` 或 `{"action":"silent"}`。选择 silent 时记录事实并结束回合，不创建 assistant 或投递。已授权的跨会话发送使用 `text` 模式。Runtime 核对变量的来源 ID、保存最终 `prompt.text`、模板和 digest；结构化任务追加 JSON Schema 协议，LLM client 使用保存的 `prompt.text` 调用模型。这条 Model Task 路径不另传 `system` 字段。[持久化与调用](https://github.com/posanbu/Kaguya/blob/main/packages/runtime/src/model-task.ts)、[LLM client](https://github.com/posanbu/Kaguya/blob/main/packages/llm/src/client.ts)。

## 查看某一次请求的完整文本

在开发者控制台打开模块的模型请求，进入“完整 Prompt”。那里展示的是该次 `core.model.task.requested` 保存的已渲染文本，经过秘密脱敏；不会用当前模板重新生成。Light 与 Heavy 分别有请求目录。也可使用[单次请求详情 API](../reference/http-api)。

## 修改时保持同步

模板正文直接由上述代码块读取，改动 `.hbs` 后文档构建会自动更新展示。新增、删除或重命名模板，以及修改变量来源、装配顺序、条件追加、授权分支或 Model Task 协议时，同一变更应更新本页的说明、片段列表和链接，并运行 `pnpm --dir docs --ignore-workspace docs:check`。
