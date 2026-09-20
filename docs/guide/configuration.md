---
title: 配置 Kaguya
description: 完成首次配置，管理多个 Profile，并理解配置何时生效。
---

# 配置 Kaguya

Profile Registry 保存 Agent identity、runtime、数据库、AI、Memory、平台与 review；全局 selected Profile 是这些字段的运行真值。模块实例配置独立位于同一配置根的 `modules/`。环境只用 `KAGUYA_CONFIG_ROOT` 定位配置根。

## 首次启动会发生什么

```mermaid
flowchart TD
  A[读取基础配置] --> B[创建 AdapterHost]
  B --> C[独立检查 AI 与数据库]
  C --> D{schema v1 完整?}
  D -- 否 --> X[监听前退出]
  D -- 是 --> E{AI 与数据库均就绪?}
  E -- 是 --> R[尝试启动 Runtime]
  E -- 否 --> F[记录降级原因]
  R --> G[启动 HTTP 与各 Adapter]
  F --> G
```

开发模式不需要手工创建配置目录。目录缺失时，`pnpm dev` 会建立 Registry、保留的 `default` Profile 和托管数据库 runtime；这个初始 Profile 的 AI 尚不完整，Web UI 会引导你填写，数据库失败不阻止页面启动。生产 `pnpm start` 不管理 Docker，也不补 runtime。

## Runtime 与数据库

Profile 的 `runtime` 保存 host、port、必填的 `databaseMode`、`databaseUrl`、Web 路径、CORS、proxy、限流、日志和 gateway allowlist。外部数据库只通过 Profile JSON 配置；Web API 不返回或接收完整 runtime，只安全投影并更新其中的 gateway allowlist。

`databaseMode: "managed"` 表示开发命令可以管理固定的本地容器；`databaseMode: "external"` 表示所有命令都只连接 Profile URL，不调用 Docker。两种模式都检查 PostgreSQL 17。连接暂时不可用可进入降级状态；旧 schema、缺失 metadata、版本不符或结构不完整会在任何监听前终止启动。

Gateway Token 不写入 runtime，也不是 runtime 的合法字段。它在每次进程启动时安全随机生成，只存在于当前进程和访问链接。

## 看懂配置状态

**`invalid`** — 所选 Profile 缺少必填项或引用不一致。按页面列出的 issue 修正字段。

**`review_required`** — 必填项有效，但当前配置仍有需要明确确认的警告。阅读警告后决定补充或确认。

**`restart_required`** — 磁盘上的所选配置已经更新，但当前进程仍使用启动时的旧对象。重启 Server 后生效。

**`ready`** — 所选 Profile 可以用于创建 Runtime。

配置文件损坏、权限不安全、路径越界或符号链接不会被自动“修好”。Server 会拒绝危险读取或写入，避免覆盖原数据。

## 填写模型配置

**Profile 名称** — 1 至 100 个字符，用于人类识别；Profile ID 是系统生成的稳定标识。

**Agent 身份** — Profile 只保存 `identity.timeZone`。主名称、别名和 persona 正文分别由工作区级 `identity.name`、`identity.aliases`、`identity.persona` Prompt 资源管理，Message Composer、Heartflow 和名称识别在启动时使用同一份解析结果。别名资源每行一个，加载时 trim、去重，且不能与主名称相同。旧 Profile 中的 `identity.name`、`identity.aliases` 或 `identity.persona` 会因为未知字段被明确拒绝，不会兼容读取或自动迁移。

```json
"identity": {
  "timeZone": "Asia/Shanghai"
}
```

**Base URL** — OpenAI-compatible Provider 的服务地址，例如供应商提供的 `/v1` 入口。

**API Key** — 只提交给当前 Kaguya Server，并以明文写入受保护的 Profile JSON。不要粘贴到 Issue、PR 或截图。

**Light Model** — 面向轻量任务的模型 ID。

**Heavy Model** — 面向重量任务的模型 ID；可以与 Light Model 使用同一个 `provider:model` 目标。

**入站与出站白名单规则** — 每行一条 `platform:group|private:target_id`。群聊目标是 group ID，私聊目标是 user ID；`platform` 与目标 ID 支持 `*`。两套规则分别按 OR 匹配，入站列表只决定消息是否进入 Runtime，出站列表只决定最终投递是否允许；空列表只拒绝对应方向的非 Web 平台消息，非法非空行会保存但不生效。Web 保持原有特殊策略。获准入站不授予跨会话发信权限，跨会话还需要管理端确认目标及正文，详见[跨会话消息](./message-targets.md)。

**启用 Memory** — 初始化 Profile 显式写为关闭；请求与文件都必须包含该字段。关闭时 Runtime 仍保留联想与 Prompt 的处理形状，但不会读取、写入、召回或主动提取实际 Memory；显式开启后才启动可靠原始消息写回与内置 PostgreSQL 稀疏召回。可选的 embedding 与 Mem0 cognition 配置通过 Profile JSON 管理，见 [Memory 认知层](../developers/memory.md)。

**配置警告确认** — 当前 UI 只允许确认 selected Profile 实际存在的警告；过期或未知 warning ID 会校验失败。

当前表单用一个 ID 为 `default-provider` 的 OpenAI-compatible Provider 建立初始配置。底层 Profile 支持更完整的 Provider和平台结构，但页面只呈现已经实现并验证的操作。

## 配置模块实例

首次启动时，如果整个 `modules/` 不存在，Kaguya 会生成六个一方实例的完整 v1 文件。此后只读取文件，不补缺失内容：目录已存在时，缺少实例、出现未知实例、版本错误、身份不匹配或 settings 缺字段都会阻止启动。

每个 `<KAGUYA_CONFIG_ROOT>/modules/<instanceId>/config.json` 必须显式包含 `version`、`instanceId`、`definitionId`、`enabled` 和完整 `settings`。修改后重启；当前不提供 HTTP 或 Web 管理接口。

默认消息生成实例为 `message-composer.default`，模块定义为 `agent.message-composer`，settings 只包含 `modelTier`。投递目标来自 Message Intent，不再配置 source/fixed outbound 或默认 reply 引用模式。

升级前请备份 `<KAGUYA_CONFIG_ROOT>/modules/`，然后移走旧模块目录，让下一次启动重新生成当前配置，再按当前 schema 恢复自定义参数。旧 reply 模块配置会明确拒绝启动；不会自动迁移。旧 `llm-reply.*.local.hbs` 也不再加载，请按新的 `message-composer.*.default.hbs` 模板重建本地覆盖。

## 本地覆盖 Prompt

仓库拥有的生产 Prompt 由 `@kaguya/prompt` 统一校验和加载。模块与身份资源位于 `packages/modules/templates/`，结构化输出协议位于 `packages/llm/templates/`。每个资源都有提交到 GitHub 的 `*.default.hbs`；标记为 editable 的资源还允许同名 `*.local.hbs`，存在时优先使用。readonly 资源（例如 JSON 输出协议）禁止 local 覆盖。

在仓库根目录执行以下命令，可为全部 editable 模板创建缺失的 local 副本，已有 local 保持原样；readonly 模板不会被初始化：

::: code-group

```bash [初始化本地 Prompt ~vscode-icons:file-type-shell~]
pnpm prompt:init
```

:::

也可以只把需要修改的 `*.default.hbs` 复制为对应的 `*.local.hbs`。可编辑范围包括工作区名称、别名、persona、消息编写通用行为、QQ/Web 表达风格、群聊与私聊场景、Heartflow Planner 与 QQ/Web 参与策略、授权正文、表达学习与选择，以及人物事实提取。平台键严格使用标准消息 `platform`；`qq`、`web` 精确匹配，其他值回退通用资源。

### 从旧 Profile 手工升级身份资源

本次升级是破坏式变更，不提供迁移命令。升级前先备份旧 `identity.name`、`identity.aliases` 和 `identity.persona`：将主名称写入 `packages/modules/templates/identity.name.local.hbs`，将别名按每行一个写入 `identity.aliases.local.hbs`，将只描述身份、经历、性格和关系的内容写入 `identity.persona.local.hbs`；把短句、活力、群聊参与等表达规则分别写入 QQ 的 style/policy 资源。随后从每个 Profile JSON 删除 `name`、`aliases`、`persona`，仅保留 `identity.timeZone`，最后重启 Server。配置页的身份资源编辑器会写相同的工作区级 local 文件，并明确提示重启生效。

模块管理页保存模板时只写 local；“恢复默认”会删除对应的 local，重新使用 default。正常启动和读取不会重新生成 local。保存、手工编辑或恢复后都需要重启 Server 才会生效。

升级代码时，新的 default 只会影响没有 local 覆盖的模板。已有 local 不会被覆盖或自动合并；需要采用新版默认内容时，可先备份自己的修改，再恢复默认或手动合并差异。

::: warning Handlebars 边界
声明的变量可以不出现，也可以重复出现；未知变量、未知或动态 partial、自定义 helper、递归 partial、空文件和读取失败会使 Server 拒绝启动。默认文件也必须存在，不会以代码内置文本代替。只开放 `each`、`if`、`unless` 与固定静态 partial，不允许任意磁盘 include。动态内容按原文写入，不会自动添加 XML 包裹或进行逃逸，模板作者必须维护清晰的数据边界与安全提示。
:::

Message Composer 的层级为消息 partial → 历史、Memory、引用上下文与完整当前 turn → 外层 `message-composer`。当前 turn 不指定一条必须回答的目标消息。历史最多 30 条；历史 12,000 字符和 Memory 4,000 字符预算按 Unicode code point 在消息层渲染后、集合层渲染前执行。可用变量和全部模板名记录在 `packages/modules/src/first-party/message-composer/README.md`。

## 管理多个 Profile

一个 Registry 可以保存多个 Profile，但任意时刻只有一个全局 selected Profile 用于 Runtime。

**新建** — 创建未选中的 Profile，并继承当前 selected Profile 的隐藏 runtime，避免切换后失去数据库与 Server 配置。AI 和平台从空值开始，Memory 显式写为关闭。

**编辑** — 对可见字段做完整替换，而不是局部 patch；Server 只把顶层 `inboundAllowlist` 和 `outboundAllowlist` 合并回隐藏 runtime，并原样保留其他 runtime 字段。目标 Profile 缺少 runtime 时会明确拒绝保存。保存当前选中的 Profile 后需显式点击“应用当前配置”；编辑未选中的 Profile 通常不会影响正在运行的 Runtime。

**选择** — 把某个 Profile 设为全局 selected。切换后需要重启。

**删除** — 只允许删除非 `default` 且非 selected 的 Profile。若要删除当前 Profile，先选择另一个 Profile并重启，再执行删除。

::: warning 没有自动回退
所选 Profile 或模型失败时，Kaguya 不会静默改用默认 Profile、其他 Provider 或其他模型。显式失败能保持行为与审计一致。
:::

## 重启让配置生效

Profile 保存成功和 Runtime 已采用新配置是两个时刻。Provider 客户端、light/heavy 路由和 Runtime 在进程启动时创建；运行中修改磁盘文件不会热重载它们。

在运行 `pnpm dev` 的终端按 `Ctrl+C`，再重新执行 `pnpm dev`。页面刷新后若状态为 `ready`，即可进入消息界面。技术原因见[配置生命周期](../developers/configuration-lifecycle)。

## 保护配置目录

**POSIX 权限** — 目录应为 `0700`，托管文件应为 `0600`。

**Windows 权限** — 生产环境应设置 NTFS ACL，只允许运行 Kaguya 的账号访问。

**单写入者** — 同一配置根目录任意时刻只运行一个管理器或写入进程；当前实现没有跨进程协调。

**原子写入** — 管理器写临时文件、同步并原子替换，降低中断造成半个文件的风险。

::: danger 凭据泄漏
如果真实密钥进入 Git，应立即撤销或轮换，再检查访问记录。删除最新文件或补 `.gitignore` 不能清除历史泄漏。
:::

完整运行字段见[环境变量与运行配置](../reference/environment-variables)，配置接口见[Profile API](../reference/profile-api)。Registry 与 Profile 都使用严格的 `version: 1`，旧结构不迁移、不双读。

## 关注租约与表达学习配置

新初始化的 modules 目录包含 attention-focus.default 与 expression.default。已有目录需要显式添加这两个 v1 实例文件，不自动改写用户配置：关注实例使用 definitionId `agent.attention.focus`、空 settings；表达实例使用 definitionId `agent.expression`、settings `{ "batchSize": 8 }`，两者 enabled 为 true。

Heartflow 增加 focusIdleMs（默认 120000 毫秒），Attention Arousal 增加 focusRelevance（默认 80）。旧实例省略这两个字段时采用默认值。关注相关性不能绕过硬门禁，也不保证必回复。

表达流水线启用后，Composer 依赖表达模块就绪；缺失或关闭表达实例会在装配阶段报告能力依赖不满足。保存配置后仍需显式应用，并按应用结果处理需要重启的变更。
