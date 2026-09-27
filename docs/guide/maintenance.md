---
title: 更新与备份
description: 更新 Kaguya 前备份配置、模板和数据库，并处理旧配置。
---

# 更新与备份

更新前先停止 Kaguya，备份自己的配置和数据，再阅读目标版本的变更说明。项目仍在开发，旧配置可能需要手工调整。

## 需要备份什么

**配置目录** — 整个 `KAGUYA_CONFIG_ROOT`，默认 `.data/kaguya-config`。包含 Profile、平台密钥和模块设置。

**本地模板** — `packages/modules/templates/` 中自己的 `*.local.hbs`。这些文件被 Git 忽略，更新代码不会替你备份。

**数据库** — 按 PostgreSQL 的备份方式保存数据。只复制配置目录不会保存聊天记录与记忆；托管数据位于 `kaguya-postgres-17-data` 卷中。

备份包含凭据和聊天内容，应存放在受限目录，不要提交到 Git 或 Issue。

## 更新源码

确认当前分支为准备更新的分支，且自己的修改已经提交或另行备份，再执行：

::: code-group

```bash [更新依赖并构建 ~vscode-icons:file-type-shell~]
git pull --ff-only
pnpm install
pnpm build
```

:::

生产模式用 `pnpm start`，开发模式用 `pnpm dev` 重新启动。打开新的访问链接，核对模型、QQ 连接和实际聊天是否正常。

## 旧配置导致启动失败

### Router / Light / Heavy 破坏式切换

此次协议切换不提供自动迁移或旧实例别名。必须先停止 Server 和所有写账本的进程，备份配置、local Prompt 和数据库，再人工清空旧 Information 数据库，以空库启动新版。不要把旧库的协议错误当作可忽略警告，也不要把旧库重新接回新版。清空会永久移除旧聊天、原始与派生记忆、人物画像、QQ 收藏以及模型任务和投递历史；需要保留时应在切换前做独立备份，旧数据不会导入新库。仅对确认属于当前工作区的数据库执行清空操作。

在 `modules/` 中人工将 `heartflow.default` 改为 `router.default`、定义 ID 改为 `agent.router`，并将 `plannerInterruptMaxConsecutiveCount` 改为 `lightInterruptMaxConsecutiveCount`；将 `message-composer.default` 改为 `heavy.default`、定义 ID 改为 `agent.heavy`，删除其 `modelTier` 并使 `settings` 为 `{}`；删除 `attention-focus.default`。Heartbeat 保留实例和已有数值，只把 `plannerInterruptQuietMs` 字段改为 `interruptQuietMs`。新版不会接受旧目录或旧字段。

将需要保留的旧 `heartflow.*.local.hbs` 与 `message-composer.*.local.hbs` 按新模板清单人工改名为 `light.*.local.hbs` 与 `heavy.*.local.hbs`，检查变量和策略后再启用。不要直接把旧本地模板复制成未校验的新 Prompt。参见[模板装配](../developers/prompt-assembly.md)。完成后启动服务，在“检查 → 模块”和模型请求页核对新实例与档位。

先根据日志中的文件或字段名查找原因，不要直接清空配置目录。

**缺少模块或模块结构已变化** — 备份并移走旧 `modules/` 目录，下一次启动生成当前默认配置，再按新字段恢复自己的参数。已经存在的模块目录不会自动补齐内容。

**仍有 `runtime.gatewayAllowlist`** — 备份后删除旧字段，明确填写 `inboundAllowlist` 和 `outboundAllowlist` 两个数组。如需保留原来的双向范围，可将旧规则复制到两侧。

**Profile 仍含身份正文** — 将旧 Profile 的 `identity.name`、`identity.aliases`、`identity.persona` 分别保存到 `memory.identity.name`、`memory.identity.aliases`、`memory.identity.persona` local 模板，别名每行一个。随后从 Profile 的 `identity` 中删除这三个字段，只保留 `timeZone`。

**模板无效** — 对照同名 default 的变量和结构修正 local。旧 `llm-reply.*.local.hbs` 不再加载，应按当前 `heavy` 模板重建。

**数据库结构或版本不兼容** — 保留备份，核对该版本要求。Router / Light / Heavy 切换按上文在停服后人工清空旧库；其他版本错误不能仅靠改写协议标记解决。

## 恢复默认模板

模块模板页的“恢复默认”只删除对应 local，重新使用随代码提供的 default。已有 local 不会自动合并更新，所以升级后风格没有变化时，应先检查是否仍有本地覆盖。恢复后需要重启。
