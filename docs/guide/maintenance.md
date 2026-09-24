---
title: 更新与备份
description: 更新 Kaguya 前备份配置、模板和数据库，并处理旧配置。
---

# 更新与备份

更新前先停止 Kaguya，备份自己的配置和数据，再阅读目标版本的变更说明。项目仍在开发，旧配置可能需要手工调整。

## 需要备份什么

**配置目录** — 整个 `KAGUYA_CONFIG_ROOT`，默认 `.data/kaguya-config`。包含 Profile、平台密钥和模块设置。

**本地模板** — `packages/modules/templates/` 中自己的 `*.local.hbs`。这些文件被 Git 忽略，更新代码不会替你备份。

**数据库** — 按 PostgreSQL 的备份方式保存数据。只复制配置目录不会保存聊天记录与记忆；托管数据位于 `kaguya-postgres-17-data` 卷中，不要删除该卷。

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

先根据日志中的文件或字段名查找原因，不要直接清空配置目录。

**缺少模块或模块结构已变化** — 备份并移走旧 `modules/` 目录，下一次启动生成当前默认配置，再按新字段恢复自己的参数。已经存在的模块目录不会自动补齐内容。

**仍有 `runtime.gatewayAllowlist`** — 备份后删除旧字段，明确填写 `inboundAllowlist` 和 `outboundAllowlist` 两个数组。如需保留原来的双向范围，可将旧规则复制到两侧。

**Profile 仍含身份正文** — 将旧 Profile 的 `identity.name`、`identity.aliases`、`identity.persona` 分别保存到 `memory.identity.name`、`memory.identity.aliases`、`memory.identity.persona` local 模板，别名每行一个。随后从 Profile 的 `identity` 中删除这三个字段，只保留 `timeZone`。

**模板无效** — 对照同名 default 的变量和结构修正 local。旧 `llm-reply.*.local.hbs` 不再加载，应按当前 `message-composer` 模板重建。

**数据库结构或版本不兼容** — 保留备份，核对该版本要求。不要删除表或重新建库来强行跳过错误；旧 SQLite 数据不会被自动转换。

## 恢复默认模板

模块模板页的“恢复默认”只删除对应 local，重新使用随代码提供的 default。已有 local 不会自动合并更新，所以升级后风格没有变化时，应先检查是否仍有本地覆盖。恢复后需要重启。
