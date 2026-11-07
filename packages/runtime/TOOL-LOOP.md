# Heavy 原生工具循环

Heavy 可以在同一次持久任务中生成工具调用、读取 W3 回执，再继续生成回复。每次模型请求只执行一步；宿主负责校验参数、授权、行动执行、预算和恢复。

## 启用与注册

服务器设置 `KAGUYA_NATIVE_MEMORY_TOOLS=1` 后，为 `agent.heavy` 的 `agent.heavy.respond` 安装 `memory.query`、`memory.read`、`memory.history`、`memory.correct` 和 `memory.record`。Memory 模块必须已启用。配置贯通服务器首次装配与 Runtime 重建；默认不启用工具循环。

其他工具通过 `MessageCompositionOptions.nativeTools` 注册。每项提供领域 ID、工具及 provider 版本、executor、description、policyVersion、readonly/independent，以及宿主的 `bind`、`authorize` 回调。输入可以使用 Zod `inputSchema`，也可以使用未经转换的 `jsonSchema` 和宿主 `validateInput`。工具目录、schema 和执行策略在 run 创建时冻结；配置变化必须更新相应版本。

`tasks` 精确匹配 definitionId、taskId、routeId，并列出允许的 toolIds。`nativeTaskModels` 为指定任务提供独立模型路由；GUI 等专用任务不会改变全局 Heavy 模型。W5/W7/W8 可以沿用该注册端口和 W3 provider，`bind` 返回宿主确认的 target 及可选 environment。模型不能注册工具、扩大 scope、生成环境令牌或批准自己的行动。

## 持久步骤与恢复

wire name 由领域 ID 和版本的 SHA-256 摘要生成，只含字母、数字、下划线及连字符，并检查注册冲突。原始 call ID、参数和原生 reasoning/provider 元数据随模型结果保存。当前 OpenAI-compatible 适配器通过其受支持的消息扩展恢复原始 arguments；即使参数 JSON 非法，持久化往返后的下一次 wire 仍保留原文及调用身份。SDK 自行生成的校验错误不充当外部执行事实。

模型请求发出前原子记录 dispatch 并消耗步骤预算。重启看到 dispatch 而没有终态时停止该 run，不重复请求。模型失败事实保存 `error.reasonCode=dispatched-without-terminal`，run 保存 `reason=model-outcome-unknown`，供检查界面区分模型结果未确认与普通生成失败。工具调用先持久化，再经过 W3 的精确授权、register、execute、readReceipt；operation 身份绑定 run、step 和 call ID。回执配对完成后才能冻结后继步骤。Heavy 只投递最终回复，中间工具分支继续留在协调器内。

默认上限为 8 个模型步骤、16 次工具调用、300 秒运行时间、每步 128000 字节输入及模型输出、每项 64000 字节工具投影、累计 256000 字节工具投影。输入核算包含工具声明和 schema。累计模型输入/输出由步骤数与各步字节上限共同约束；重启不复位预算。单次模型超时同时受剩余 run 时间和 300 秒请求上限约束。

副作用串行执行；同时声明 readonly 和 independent 的工具可以有界并行，默认并发数为 2。上下文按完整 call/result 段裁剪，保留图像及开放配对。实际请求的 `contextTrimming` 保存 `truncated`、`omittedSegments`、`originalBytes`、`retainedBytes` 和 `budgetBytes`；`measurement=native-message-array-json-utf8` 表示字节数只计追加当前 prompt 前的原生消息数组，不含工具声明。各被省略段的原模型结果和工具回执继续保留在账本中。工具输出超限时保留完整 W3 回执，投影截断标记并停止后续生成。超时、取消、租约失效和 supersede 停止新推进并请求取消已登记行动；unknown、partial、fenced 和迟到回执继续保留其真实语义。

## Memory 与行动证据

query/read/history 从宿主冻结 snapshot 取得 scope、owners、时间和 publication cutoff。历史游标绑定读上下文及上界；每个历史 revision 分别核验权限、来源及当前失效状态。更正限定为宿主允许的自身经验节点，固定 automatic actor 和目标 revision。模型不能设置 proofOwners、manual actor 或身份权限。

record/correct 仅接受宿主验证的同一 run 实际回执。宿主用当前授权重读 W3 receipt，核对 intent、attempt、call 及摘要，然后桥接为专用 `action-result` canonical source。正文和完整 sourceOwners 从持久事实派生；该来源保留上游证据依赖，因此原始来源撤回也会使派生记忆失效。自身行动与工具观测保持各自证据语义，executor 不等同于人物 speaker。

Memory 发布与行动最终授权检查共用串行事务边界。发布后更新快照时间和截止点，由后继步骤继承；普通步骤及查询沿用已有边界。初始 observation 和旧 step 保持不变。后继请求引用实际 call/result 及 Memory snapshot，`dependenciesFor` 从这些持久事实重建初始和补充依据，拒绝跨 observation 或伪造的 step0 快照。

## 验证与回退

`pnpm test:critical` 包含原生循环、LLM 协议、Runtime 能力隔离和 Web→Runtime→Heavy 路径测试。`pnpm test:postgres` 在显式 PostgreSQL 测试数据库上覆盖数据库及运行链路。原生循环 fixture 同时支持 PGlite 和 PostgreSQL，使用持久状态与 barrier 验证 dispatch、执行、回执和恢复窗口，并检查 provider/effect 次数。测试模型为本地合成 provider，不消耗外部 LLM 请求。

环境 start 的 accepted 只表示已受理；查询、停止及外部效果核实遵循 W3/W6 契约。关闭工具配置前先停止新 run 并排空活动任务；保留新 Kind、步骤、call/result、unknown、canonical source 和 publication。回退版本必须能读取这些持久记录。
