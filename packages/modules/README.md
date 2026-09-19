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

所有一方模块的可编辑 Prompt 都保存在 `templates/`：`*.default.hbs` 是提交到 GitHub 的默认模板，同名 `*.local.hbs` 是 Git 忽略的本地覆盖。范围包括 Message Composer 的主模板、消息与记忆排版、会话场景、积压提示、人物背景、表达参考和授权正文，Heartflow Planner、Expression 的学习与选择，以及人物事实提取；没有模型指令的模块不需要占位模板。

在仓库根目录运行 `pnpm prompt:init`，可为所有已声明模板创建缺失的 local 副本；已有 local 保持原样。也可以只复制需要修改的 default 文件。加载时优先使用 local，仅在 local 不存在时读取 default；因此升级默认模板不会覆盖本地定制，已有 local 也不会自动合并上游变化。本地覆盖属于当前工作区，供使用该模板的实例和 Profile 共享。

管理端保存只写 local；恢复默认会删除对应 local，随后使用 default。正常读取和启动不会重新创建 local，保存或恢复均需重启服务后生效。默认文件缺失、选中的模板为空或非法时会明确失败，不回退到代码内置文本。

`src/prompt-declarations.ts` 集中声明模板归属、变量和组成关系，Node composition root 通过 `@kaguya/modules/prompt-templates/node` 读取并校验。模板在模块构造时编译，运行时复用；主入口不导出 Node loader，保持模块渲染边界为纯函数。跨会话授权正文由 composition 注入 Runtime 的渲染器生成，Runtime 只提供冻结说明与背景及其来源引用，不读取模板文件。
