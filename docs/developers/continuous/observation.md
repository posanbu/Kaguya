---
title: 情境与观察
description: scene、持久冻结清单、消费者独立水位与 Lifecycle 恢复契约。
---

# 情境与观察

总背景、当前情境和主行动线的公共定义见[对象与关系](../situation-model/objects)，冻结、变化说明与预算见[上下文装配](../situation-model/assembly)。本页继续约束 Kaguya 的场景映射、独立进度和现有协议迁移。总背景关联所有启用入口，仍保留每份证据的来源与 scope。

本页对应 [#247](https://github.com/posanbu/Kaguya/issues/247) 和 [#279](https://github.com/posanbu/Kaguya/issues/279) 的 W1。默认 `agent.lifecycle` 与 Situation/Router 已接入公共观察端口。多个 tick 可以组成一次有界读取；数据库分别记录接收、已分配和连续成功边界。Memory 的历史版本查询、通用行动取消与检视界面由后续工作包接续。

## 身份与范围

**Scene 身份** — 为明确的互动场景分配稳定标识，登记入口地址与现有 scope 的映射版本。初期保持群聊、私聊和 Web conversation 的既有隔离；群改名或人物改昵称不改变稳定身份。跨平台场景关联必须是显式操作，不依据昵称相似自动合并。一个 Information 可通过明确关联进入多个 scene；每个 scene 独立记录处理进度。

**Scope** — 声明消费者获准读取的范围。Scene 关联不自动扩大读取权限，跨 scene 的工具结果只向原授权目标传播。历史 scope key 保留为映射输入，不能替换原始引用。

**Tick 身份** — 由 scene、来源 Information ID 和唤醒原因定位；相同来源、相同原因的重复通知不生成第二份证据。定时重唤醒关联持久 schedule 及原待处理范围。唤醒策略有版本，业务结果是否再次唤醒须由对应 Kind 的契约声明。

**Context 与 observation 身份** — Context 包含待消费范围及必要的历史、人物和记忆版本。Observation 是对该 context 的一次有界读取，拥有稳定 ID；运行 attempt 与业务 observation 分开。冻结输入清单一经提交就不能因重试而变化。`agent:observation` capability 版本 1 提供 `discover/freezeNext/read/pending/finish/fail/defer/replace/supersede/progress`。操作键在同一 stream 内唯一；重放返回原快照，包含已完成快照。

## 三种边界不能混用

**接收边界** — 该 scene 中已持久接纳的 Information 上界。遍历按账本注册位置推进，使用账本可稳定解析的 cursor/Information 引用，不按 UUID 字符串或业务时间比较大小。

**观察进度** — 按 scene、消费者职责及契约版本记录已成功读取的连续范围。前台感知与后台 Memory 分别持有进度，不能相互代为确认。成功 observation 只提交自己声明的范围；后续范围先完成时，保留完成段，不能越过中间失败段推进连续水位。

**领域进度** — Memory 已发布的版本、action 已执行的结果分别由对应领域拥有。它们引用 observation，但不写回观察进度来掩盖失败。

事件发生时间用于理解先后、有效期和更正；账本接收顺序用于发现待处理输入。昨天发生、今天才接收的消息属于新的待处理范围，同时保留昨天的发生时间。查询上限或截断必须生成后续分页任务，不能把“已返回前 1000 条”解释成观察到整个接收上界。

## 冻结与提交

形成器先在授权 scope 内读取尚未处理的连续范围，选定本次上界，补充必要的历史来源和精确 Memory revision，再持久化输入清单、范围、策略版本与缺失状态。新 tick 可以在冻结前并入；冻结后只能增加后续待处理范围。

上下文中的历史补充不重复推进进度。待消费范围则必须完整，或者显式记录可审计的排除决定。缺少必须输入或来源尚未完成正规化时，该页保持未完成。`hasMore` 表示还有下一页；本页内容完整即可成功，不必等待整条流清空。可选历史引用缺失可以作为受限 context 完成，但缺失必须对下游可见，不能补造内容。

成功状态及其进度更新应在同一原子提交中生效，或由唯一完成事实驱动可幂等重建的进度投影。一个 observation 只能有一个成功提交；并发提交通过预期进度版本校验，失败者重新读取状态，不覆盖胜者。

完成 observation 证明快照按契约完整可用，不证明事实推断正确，也不要求已调用 Light。Light 失败不会撤销已成功的读取；后续判断可以引用旧 observation 加新 observation，无需通过伪造“未读”重跑全部输入。

## 合并、延期与恢复

同一 scene、兼容读取权限和消费职责的待处理 tick 可以合并。不同 scene 不因时间接近而合并水位；跨场景 context 逐一引用各自快照和范围。合并仅改变何时处理及如何组织输入，不删除来源事实。

Arousal 的 `defer` 记录下一次检查条件和到期唤醒，不能确认正文已读。低优先级信息允许积累，但需要可恢复的到期检查或积压触发，避免系统只在新的活跃消息到来时才发现旧证据。具体延迟、数量阈值属于可配置策略，不写死为统一窗口。

失败 attempt 保留错误、冻结快照和重试身份；重试复用已经冻结的输入。若冻结尚未成功，新的读取尝试可重新选择上界，但必须与旧未完成操作建立关系。放弃某个 attempt 不消费其范围；废弃旧 observation 时，必须留下替代 observation 或明确的排除记录。不可恢复错误进入可见的待处理/人工处置状态，禁止默默前移水位。

恢复入口从持久接收边界、进度、开放任务和终态重建待处理范围，不能只订阅启动后的新 Information。实现时需要证明原子写入成功但广播前崩溃、快照提交后崩溃、成功事实写入但投影未更新三种情况下均可恢复。本文不要求为此给 Core 增加通用消费系统；可以复用并扩展现有模块持久任务机制。

## 当前实现

`packages/schema/src/scene.ts` 将完整入口映射为 `["scene.v1", platform, adapterId, destination.kind, id]`，保留原 Heartbeat 和历史 cognition key。`memory.native` 的现行 scope 为 `[platform, adapterId, destination.kind, id]`；这些标识不互相改写。同群多个 sender、不同平台消息 ID 共享场景，私聊和 Web conversation 保留各自地址边界。

`information_observation_progress` 按 scene、consumer、policy 和可选 sender 隔离；读取契约首次登记后不能静默修改。Situation 使用 `agent.situation` / `observation.v1`。其他消费者必须独立确认自己的快照，前台完成不代替 Memory 发布。

`information_observations` 固定来源、补充上下文、上下界、策略和 manifest。Manifest 引用持久 turn 的 claim ID、`agent.situation.frozen` 和知识截止点，并保存完整 frame 与 Memory revision 清单。数据库核对来源集合与持久 turn 的 inputs、地址、正文及上界，再核对 frame 与 revision。正文没有覆盖的来源保留为不完整页。相同操作重试复用旧 frame；后来发布的 Memory 不进入旧清单。

冻结与入站提交使用同一旧 scope 的事务锁，再按完整地址筛选；不同 scope 不加全局提交锁。全局 `max(position)` 不充当通用提交前沿。分页分配和成功合并使用 stream 行锁；`finish` 要求完成事实直接引用本页来源、上下文、claim 和冻结 frame。后段成功保留记录，只有相邻成功段才能推进连续水位。`replace` 保留原页并显式关联新冻结，`supersede` 与成功提交共享进度锁。

Situation 在持久冻结后登记快照，在 observe gate 后、模型执行前登记 `agent.observation.completed.v1`。`agent.observation.progress.v1` 是可重建进度事实；`observedThroughInformationId: null` 表示还没有成功输入，不能转成字符串 cursor。Light 错误不撤销已确认的观察。

Lifecycle 启动时分页扫描已有来源，按完整场景地址恢复未确认输入及原运行上下文；新消费者从零发现历史，不把旧 turn 的最新边界冒充成功。Defer 安排持久 `observation-recheck`，到期后重新检查，即使没有新消息也能继续。既有未来定时任务保留原 deadline；重复启动复用开放候选。原 heartbeat、attention-arousal 和 Situation durable subscription ID 保持不变。

### 映射样例与冲突处理

以下样例用于区分当前地址与历史别名；示例中的 `qq`、`napcat`、`G`、`U` 是合成地址，`C` 表示有效的 Web conversation UUID。新的 scene 标识登记这些地址的结构化映射，不能仅解析旧字符串推断身份。

- **群聊**：平台 `qq`、适配器 `napcat`、群 `G` 的 Heartbeat scope 是 `qq:napcat:group:G`；cognition key 为 `["scene.v2","qq","napcat",null,{"kind":"group","groupId":"G"}]`。同群不同发言者共享场景，人物归属仍逐条保留。
- **私聊**：目标 `U` 对应 `qq:napcat:private:U`；cognition key 还包含来源 `senderId`。映射到同一入口地址不意味着可以取消该 sender 读取约束；历史上分开的消费范围继续分别读取。
- **Web**：带 conversation `C` 的 Heartbeat scope 为 `web:web:web:C`（假设平台和适配器均为 `web`）；无 conversation 的旧输入使用 `web:web:web:`。两者保持隔离。cognition key 同时保留 destination 和 sender，不把所有 Web 输入归为一个会话。

旧 Heartbeat key 用冒号连接地址，不能假定该字符串可以无歧义地反向拆分。例如 `(platform=a:b, adapterId=c)` 和 `(platform=a, adapterId=b:c)` 可能生成相同字符串。迁移以来源 atom 中的完整地址及已有权限契约为证据；相同旧 key 下出现不同地址时分开映射，缺少地址的旧记录保留为未解析状态，不自动扩大可读范围。

现有 durable subscription 能恢复其已登记交付，但新增订阅不会自动获得此前全部历史。启用独立 observation 消费者时，持久登记读取契约；默认扫描起点为零，显式 `startAfterInformationId` 作为契约的一部分固定；无法证明旧 context 完整覆盖的区间保持待处理，不能直接把最新 `agent.router.turn.context.completed` 当作所有新消费者的起始成功水位。

## 可验证时序与未采用方案

在 scene G 接收 a、b，冻结 O1 覆盖 a–b；规划期间接收 c，c 属于后续 O2。O1 成功、Light 失败后重启，前台观察进度仍止于 b，待处理 c 被恢复；重试 Light 引用原 O1。若 O1 读取失败，即使 O2 已完成，也不能跳过 a–b 的缺口。若 c 的发生时间早于 a，接收顺序仍确保 c 被发现。

验收还应覆盖重复 tick、超过单页上限、相同发生时间、defer 后无新消息、映射冲突和两个 worker 并发提交。断言观察范围、成功事实和水位，不以等待固定时长代替完成条件。

未采用“每 tick 一次 observation”，因为它把通知频率变成语义边界；未采用“按事件时间取最近 N 条作为消费水位”，因为迟到消息和分页会破坏完整性；未采用“所有模块共享一个已处理指针”，因为后台形成和行动完成具有不同失败边界。

实现与迁移跟踪在 [#247](https://github.com/posanbu/Kaguya/issues/247)；跨领域检视与完整时序验收见 [#250](https://github.com/posanbu/Kaguya/issues/250)。

## 七个扩展时机

以下时机复用 Kind、capability、Selector 和 Cordis 生命周期。观察订阅只能追加自己声明的事实；来源、冻结正文和其他领域的成功状态由原 owner 维护。模块卸载通过宿主 signal 取消在途工作，可靠订阅按现有 lease/fencing 保证迟到写入不能抢占新持有者。能力版本与 Kind schema 不兼容时在启动预检失败。

**持久接纳** — Runtime `submit` 通过 InformationCore 原子接纳 context/inbound；同场景锁保护接纳与冻结顺序。输入为带原生地址的消息，输出为持久 Information ID。后续订阅不修改正文；广播失败由可靠交付恢复，不重新制造原始消息。

**冻结** — `agent.situation.freeze` 消费已正规化 turn，经 Raw/native Memory capability 固定正文，登记 `agent.situation.frozen` 与 observation manifest。来源页最多 1000 条；不足的页保持不完整。操作键固定，错误由 durable 重试复用已存 frame，截止点之后的知识留给后继观察。

**模型决策前** — Router 消费 observe gate，确认本次完整读取并发布连续进度，再调用模型能力。claim/run 身份此时已经存在，尚无行动意图；W3 可据此关联运行和干预。模型 token、超时与取消预算沿用 ModelTask 配置，模型失败不改写观察成功。

**执行前** — 现有 message intent 经 Runtime 的授权与最终 transport 检查，delivery 自己拥有副作用状态。W1 提供冻结、run、scene、consumer、cutoff、完整性和 revision 引用；通用行动时效和取消竞争由 W3 实现，不由观察端口裁决。

**结果接纳** — 执行器将 delivered/failed/unknown 或模型终态写回原引用链，唯一终态槽抑制重复结果。完成 observation 必须引用其全部证据，数据库在一次事务中更新成功段和连续进度。外部发送结果未知时，观察进度不能作为重发依据。

**后台发布** — `memory.native.formation.requested.v1` 和既有 `memory.native.form` 持久订阅继续拥有形成及 revision 发布。发布失败不确认前台观察，前台完成也不确认后台形成；W1 保存实际读到的精确版本，W2 接续历史查询与失效传播。

**插件启停** — ModuleHost/Cordis 在启动时校验 Kind、Selector 和 required capability，再安装订阅、启动可靠领取、发出 ready。退出停止领取、传播取消并有界清理；重启构造新的 core/runner，沿稳定订阅 ID 恢复。新增订阅的历史补扫由 Lifecycle 明确完成，不依赖安装顺序。

## 迁移与回退

`prepareSchema` 在既有 ledger 之后幂等增加 scene、progress、snapshot、attempt 表和索引。升级原 #255 表时保留原快照、水位和策略，补齐分配/发现边界；旧记录的 `manifest: null` 表示没有新版本的正文证明。新字段不改变原始 Information、Raw、scope 或 `memory_native_epoch`。

启用默认模块即开始独立回填；不从旧前台终态推导跨消费者成功。离线历史较多时按有界来源页继续处理，缺口留在 pending。数据库与配置恢复点应在部署前由 W12 备份并核对。

退出前停止新领取并排空在途工作，保留全部事实与观察表。此版本允许多个开放范围和显式替代，原 #255 单开放快照实现不能直接接管这些数据；回退程序前须确认其消费语义兼容，或停用新消费者并保留其数据供恢复。回退不删除观察表、不重置水位，也不自动恢复旧 writer。
