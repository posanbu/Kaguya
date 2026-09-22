---
title: 角色与回复风格
description: 修改 Kaguya 的名称、人设、时区和平台表达方式。
---

# 角色与回复风格

想改“她是谁”，编辑身份资源；想改“怎样说话”，编辑消息编写模板；想改“什么时候接话”，调整参与策略和[发言频率](./reply-settings)。这些设置可以分别调整。

## 名称、别名和人设

配置页的“Agent 身份”提供工作区资源编辑器：

**名称 `identity.name`** — 机器人主名称。

**别名 `identity.aliases`** — 每行一个称呼，例如“辉夜”。不要与主名称重复；这些称呼也用于识别聊天中的叫名。

**人设 `identity.persona`** — 描述身份、经历、性格与关系。回复长度和平台表达习惯放到风格模板中，方便单独调整。

**时区 `identity.timeZone`** — 默认 `Asia/Shanghai`，使用 IANA 时区名称，用于提示词中的当前时间与消息时间显示。动态频率时段目前按服务器本地时区匹配。它保存在当前 Profile 中。

名称、别名、人设是工作区共用资源，修改会影响所有 Profile。保存或恢复默认后，**重启 Kaguya** 才生效。

## 回复太长、语气不合适时改哪里

在“检查 → 模块”打开相应模块的 Prompt 模板。

**消息编写模块 → `message-composer.behavior`** — 通用回复要求，例如信息量、避免重复和表达方式。

**消息编写模块 → `message-composer.platform-style-qq` / `platform-style-web`** — 分别调整 QQ 与 Web 的说话风格；通用回退模板为 `message-composer.platform-style`。

**消息编写模块 → `message-composer.scene`** — 群聊、私聊等场景的表达要求。

**Heartflow → `heartflow.planner`** — 决定回复、等待或静默的整体要求。

**Heartflow → `heartflow.platform-policy-qq` / `platform-policy-web`** — 分平台调整参与对话的方式；通用回退模板为 `heartflow.platform-policy`。

表达学习模块的 `expression.learn` 和 `expression.select` 分别影响表达习惯的学习与选择。页面会列出模板用途和允许变量，修改前先看这些说明。

每次围绕一个可观察的问题修改，例如“QQ 回复经常重复上一句”。保存、重启后，用相近场景检查效果；仅修改 Planner 不会直接规定最终回复的全部措辞。

## 默认模板与本地模板

仓库中的 `*.default.hbs` 是随版本更新的默认内容。网页保存会写入同名 `*.local.hbs`，本地文件优先使用，并被 Git 忽略。“恢复默认”会删除该本地覆盖。

也可以在源码目录手工编辑。以下命令只补齐缺失的可编辑副本，不覆盖已有修改：

::: code-group

```bash [初始化本地模板 ~vscode-icons:file-type-shell~]
pnpm prompt:init
```

:::

角色和模块模板位于 `packages/modules/templates/`。页面标记为只读的协议模板不支持本地覆盖。

升级时已有 local 不会自动合并新版 default。需要新版内容时，先备份自己的修改，再恢复默认或手工合并。不要使用页面未声明的变量或模板引用；空文件或非法模板会阻止启动。
