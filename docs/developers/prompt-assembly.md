---
title: LLM Prompt 装配与模板原文
description: 查看 Planner、Composer 与结构化输出协议的生产模板，以及最终请求文本的形成方式。
---

# LLM Prompt 装配与模板原文

本页代码块在文档构建时直接读取仓库里的 `.default.hbs` 文件，显示的是生产模板原文，不另存一份副本。修改现有模板正文后，重新构建文档就会显示新内容。仓库源码也可以从 [模块模板目录](https://github.com/posanbu/Kaguya/tree/main/packages/modules/templates)和 [LLM 协议模板目录](https://github.com/posanbu/Kaguya/tree/main/packages/llm/templates)直接打开。

模板中的双花括号标记在每次请求时填入动态变量；`if`、`each` 块控制条件和循环；静态 partial 插入下方对应的子模板。本地 `*.local.hbs` 覆盖可编辑资源时，运行时使用 local 内容，因此某次请求的最终文本应以请求详情中的持久化 Prompt 为准。

## Planner：决定是否发送

Heartflow 把冻结 turn、身份、同会话历史、选中记忆、平台参与策略和当前会话背景填入 [Planner 主模板](https://github.com/posanbu/Kaguya/blob/main/packages/modules/templates/heartflow.planner.default.hbs)。`turn` 包含完整本轮输入、引用解析结果、可用动作及等待预算；历史与记忆有独立预算。[变量编译位置](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/heartflow/planner.ts)。

::: code-group

<<< ../../packages/modules/templates/heartflow.planner.default.hbs [Planner 主模板 ~~vscode-icons:file-type-handlebars~~]

:::

`bootstrap_policy` 和 `platform_policy` 来自以下模板；平台策略按 QQ、Web 或默认资源选择。

::: code-group

<<< ../../packages/modules/templates/heartflow.bootstrap-policy.default.hbs [冷启动策略 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heartflow.platform-policy.default.hbs [默认平台 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heartflow.platform-policy-qq.default.hbs [QQ 平台 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/heartflow.platform-policy-web.default.hbs [Web 平台 ~~vscode-icons:file-type-handlebars~~]

:::

Planner 是 `object` Model Task。Runtime 先把任务输出 schema 转为 JSON Schema，将下方协议追加到正文末尾，然后保存 `core.model.task.requested` 并发起模型调用。[协议装配位置](https://github.com/posanbu/Kaguya/blob/main/packages/runtime/src/model-task.ts)。

::: code-group

<<< ../../packages/llm/templates/structured-output-json.default.hbs [JSON Schema 协议 ~~vscode-icons:file-type-handlebars~~]

:::

## Composer：生成普通回复正文

Planner 选择 `message` 后，Composer 根据消息意图重载冻结 turn。`plan` 只展示选定话题的输入及 `topic`、`replyAct`、可选 `guidance`；`turn` 展示本轮全部输入。历史只含同目标的入站和已成功投递的 assistant 消息，最多 30 条、12,000 个 Unicode 字符；记忆最多 4,000 个字符。本轮输入不受历史预算裁剪。[上下文选择](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/message-composer/message-context.ts)、[变量编译](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/message-composer/message-prompt.ts)。

以下是 [Composer 主模板](https://github.com/posanbu/Kaguya/blob/main/packages/modules/templates/message-composer.default.hbs)，其中 `behavior_policy`、`platform_style`、`scene`、`bootstrap`、`history`、`memory`、`plan`、`turn` 会替换为后续模板渲染结果；`persona`、身份、时间、冻结事实和上下文状态也在请求时填入。

::: code-group

<<< ../../packages/modules/templates/message-composer.default.hbs [Composer 主模板 ~~vscode-icons:file-type-handlebars~~]

:::

### 行为、平台与场景

`behavior_policy` 来自通用规则；`platform_style` 选 QQ、Web 或默认资源；`scene` 根据群聊/私聊及积压状态渲染；`bootstrap` 表达冻结的可知状态。

::: code-group

<<< ../../packages/modules/templates/message-composer.behavior.default.hbs [通用行为 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.platform-style.default.hbs [默认风格 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.platform-style-qq.default.hbs [QQ 风格 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.platform-style-web.default.hbs [Web 风格 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.scene.default.hbs [场景 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.bootstrap.default.hbs [上下文可靠性 ~~vscode-icons:file-type-handlebars~~]

:::

### 历史、记忆、计划与完整本轮

`history-inbound` 同时用于历史入站、话题锚点和本轮输入；引用正文经同目标、冻结截止时间与唯一来源核验后，作为该条输入的 `quoted_message` 展示。

::: code-group

<<< ../../packages/modules/templates/message-composer.history.default.hbs [历史列表 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.history-inbound.default.hbs [入站消息 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.history-assistant.default.hbs [已发送消息 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.memory.default.hbs [记忆列表 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.memory-item.default.hbs [单条记忆 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.plan.default.hbs [表达意图 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.turn.default.hbs [完整本轮 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.quoted.default.hbs [引用消息 ~~vscode-icons:file-type-handlebars~~]

:::

### 条件追加与授权发送

普通回复在有冻结会话背景时，于主模板后追加 `conversation-background`；有表达选择时继续追加 `expression-habits`。已获授权的跨会话发送使用独立的 automatic/admin 模板，输入为已批准的 `instruction` 和可用的冻结背景。[分支位置](https://github.com/posanbu/Kaguya/blob/main/packages/modules/src/first-party/message-composer/index.ts)。

::: code-group

<<< ../../packages/modules/templates/message-composer.conversation-background.default.hbs [会话背景 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.expression-habits.default.hbs [表达习惯 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.authorized-automatic.default.hbs [自动授权 ~~vscode-icons:file-type-handlebars~~]
<<< ../../packages/modules/templates/message-composer.authorized-admin.default.hbs [管理员授权 ~~vscode-icons:file-type-handlebars~~]

:::

Composer 是 `text` Model Task，不追加 JSON Schema 协议。Runtime 核对变量的来源 ID、保存最终 `prompt.text`、模板和 digest；LLM client 使用保存的 `prompt.text` 调用 `generateText`。这条 Model Task 路径不另传 `system` 字段。[持久化与调用](https://github.com/posanbu/Kaguya/blob/main/packages/runtime/src/model-task.ts)、[LLM client](https://github.com/posanbu/Kaguya/blob/main/packages/llm/src/client.ts)。

## 查看某一次请求的完整文本

在开发者控制台打开模块的模型请求，进入“完整 Prompt”。那里展示的是该次 `core.model.task.requested` 保存的已渲染文本，经过秘密脱敏；不会用当前模板重新生成。Planner 与 Composer 分别有请求目录。也可使用[单次请求详情 API](../reference/http-api)。

## 修改时保持同步

模板正文直接由上述代码块读取，改动 `.hbs` 后文档构建会自动更新展示。新增、删除或重命名模板，以及修改变量来源、装配顺序、条件追加、授权分支或 Model Task 协议时，同一变更应更新本页的说明、片段列表和链接，并运行 `pnpm --dir docs --ignore-workspace docs:check`。
