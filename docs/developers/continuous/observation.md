---
title: 情境与观察
description: scene、tick、冻结快照与可恢复观察进度的目标契约。
---

# 情境与观察

本文回应 [#244](https://github.com/posanbu/Kaguya/issues/244)，属于[持续情境契约](./)中的待实现设计。目标是使多个 tick 能共同形成一次有界读取，并在并发和重启后说明哪些信息已被读取、哪些仍待处理。

## 身份与范围

**Scene 身份** — 为明确的互动场景分配稳定标识，登记入口地址与现有 scope 的映射版本。初期保持群聊、私聊和 Web conversation 的既有隔离；群改名或人物改昵称不改变稳定身份。跨平台场景关联必须是显式操作，不依据昵称相似自动合并。一个 Information 可通过明确关联进入多个 scene；每个 scene 独立记录处理进度。

**Scope** — 声明消费者获准读取的范围。Scene 关联不自动扩大读取权限，跨 scene 的工具结果只向原授权目标传播。历史 scope key 保留为映射输入，不能替换原始引用。

**Tick 身份** — 由 scene、来源 Information ID 和唤醒原因定位；相同来源、相同原因的重复通知不生成第二份证据。定时重唤醒关联持久 schedule 及原待处理范围。唤醒策略有版本，业务结果是否再次唤醒须由对应 Kind 的契约声明。

**Context 与 observation 身份** — Context 包含待消费范围及必要的历史、人物和记忆版本。Observation 是对该 context 的一次有界读取，拥有稳定 ID；运行 attempt 与业务 observation 分开。冻结输入清单一经提交就不能因重试而变化。这里的名称是领域身份，具体 Schema 和唯一约束由实现任务定义。

## 三种边界不能混用

**接收边界** — 该 scene 中已持久接纳的 Information 上界。遍历按账本提交顺序推进，使用账本可稳定解析的 cursor/Information 引用，不按 UUID 字符串或业务时间比较大小。

**观察进度** — 按 scene、消费者职责及契约版本记录已成功读取的连续范围。前台感知与后台 Memory 分别持有进度，不能相互代为确认。成功 observation 只提交自己声明的范围；后续范围先完成时，保留完成段，不能越过中间失败段推进连续水位。

**领域进度** — Memory 已发布的版本、action 已执行的结果分别由对应领域拥有。它们引用 observation，但不写回观察进度来掩盖失败。

事件发生时间用于理解先后、有效期和更正；账本接收顺序用于发现待处理输入。昨天发生、今天才接收的消息属于新的待处理范围，同时保留昨天的发生时间。查询上限或截断必须生成后续分页任务，不能把“已返回前 1000 条”解释成观察到整个接收上界。

## 冻结与提交

形成器先在授权 scope 内读取尚未处理的连续范围，选定本次上界，补充必要的历史来源和精确 Memory revision，再持久化输入清单、范围、策略版本与缺失状态。新 tick 可以在冻结前并入；冻结后只能增加后续待处理范围。

上下文中的历史补充不重复推进进度。待消费范围则必须完整，或者显式记录可审计的排除决定。缺少必须输入、来源尚未完成正规化或有未解决分页时，observation 保持未完成。可选历史引用缺失可以作为受限 context 完成，但缺失必须对下游可见，不能补造内容。

成功状态及其进度更新应在同一原子提交中生效，或由唯一完成事实驱动可幂等重建的进度投影。一个 observation 只能有一个成功提交；并发提交通过预期进度版本校验，失败者重新读取状态，不覆盖胜者。

完成 observation 证明快照按契约完整可用，不证明事实推断正确，也不要求已调用 Planner。Planner 失败不会撤销已成功的读取；后续判断可以引用旧 observation 加新 observation，无需通过伪造“未读”重跑全部输入。

## 合并、延期与恢复

同一 scene、兼容读取权限和消费职责的待处理 tick 可以合并。不同 scene 不因时间接近而合并水位；跨场景 context 逐一引用各自快照和范围。合并仅改变何时处理及如何组织输入，不删除来源事实。

Arousal 的 `defer` 记录下一次检查条件和到期唤醒，不能确认正文已读。低优先级信息允许积累，但需要可恢复的到期检查或积压触发，避免系统只在新的活跃消息到来时才发现旧证据。具体延迟、数量阈值属于可配置策略，不写死为统一窗口。

失败 attempt 保留错误、冻结快照和重试身份；重试复用已经冻结的输入。若冻结尚未成功，新的读取尝试可重新选择上界，但必须与旧未完成操作建立关系。放弃某个 attempt 不消费其范围；废弃旧 observation 时，必须留下替代 observation 或明确的排除记录。不可恢复错误进入可见的待处理/人工处置状态，禁止默默前移水位。

恢复入口从持久接收边界、进度、开放任务和终态重建待处理范围，不能只订阅启动后的新 Information。实现时需要证明原子写入成功但广播前崩溃、快照提交后崩溃、成功事实写入但投影未更新三种情况下均可恢复。本文不要求为此给 Core 增加通用消费系统；可以复用并扩展现有模块持久任务机制。

## 当前实现映射与缺口

[`Heartbeat scopeOf`](https://github.com/posanbu/Kaguya/blob/ff5544603f528601b7a8930cf0396199691de4c2/packages/modules/src/first-party/heartbeat/observation.ts)按入口地址构造 scope，candidate 携带未读边界；Selector 从 `agent.turn.context.completed` 读取观察水位。Attention Arousal 在正文读取前选择 observe/defer；Heartflow 持久化完整输入和 `observedThroughInformationId`，这些是可保留的基础。

[`Memory cognition`](https://github.com/posanbu/Kaguya/blob/ff5544603f528601b7a8930cf0396199691de4c2/packages/modules/src/first-party/memory-cognition/index.ts)使用独立 `scene.v2` key；其窗口选择规则也不同于 Heartbeat。实现应列出群聊、私聊、Web conversation 等映射样例并验证隔离，不能直接把两个 key 视为同义词。已有 `agent.turn.*` 的 terminal 继续描述当前协议，不自动解释为本设计中所有消费者的成功观察。

后续工作包括统一映射契约、持久消费范围、快照版本及进度投影；协议新增字段使用版本化读取，旧记录通过明确兼容路径查询。旧记录只能证明其原本保存的范围，不能为其补造缺失的完整性证明。

### 映射样例与冲突处理

以下样例来自上述两处当前实现，用于约束迁移；示例中的 `qq`、`napcat`、`G`、`U` 是合成地址，`C` 表示有效的 Web conversation UUID。新的 scene 标识应登记这些地址的结构化映射，不能仅解析旧字符串推断身份。

- **群聊**：平台 `qq`、适配器 `napcat`、群 `G` 的 Heartbeat scope 是 `qq:napcat:group:G`；cognition key 为 `["scene.v2","qq","napcat",null,{"kind":"group","groupId":"G"}]`。同群不同发言者共享场景，人物归属仍逐条保留。
- **私聊**：目标 `U` 对应 `qq:napcat:private:U`；cognition key 还包含来源 `senderId`。映射到同一入口地址不意味着可以取消该 sender 读取约束；历史上分开的消费范围继续分别读取。
- **Web**：带 conversation `C` 的 Heartbeat scope 为 `web:web:web:C`（假设平台和适配器均为 `web`）；无 conversation 的旧输入使用 `web:web:web:`。两者保持隔离。cognition key 同时保留 destination 和 sender，不把所有 Web 输入归为一个会话。

旧 Heartbeat key 用冒号连接地址，不能假定该字符串可以无歧义地反向拆分。例如 `(platform=a:b, adapterId=c)` 和 `(platform=a, adapterId=b:c)` 可能生成相同字符串。迁移以来源 atom 中的完整地址及已有权限契约为证据；相同旧 key 下出现不同地址时登记冲突并分开映射，缺少地址的旧记录保留为未解析状态，不自动扩大可读范围。

现有 durable subscription 能恢复其已登记交付，但新增订阅不会自动获得此前全部历史。启用独立 observation 消费者时，需要持久登记扫描起点、读取契约与回填任务；无法证明旧 context 完整覆盖的区间保持待处理，不能直接把最新 `agent.turn.context.completed` 当作所有新消费者的起始成功水位。

## 可验证时序与未采用方案

在 scene G 接收 a、b，冻结 O1 覆盖 a–b；规划期间接收 c，c 属于后续 O2。O1 成功、Planner 失败后重启，前台观察进度仍止于 b，待处理 c 被恢复；重试 Planner 引用原 O1。若 O1 读取失败，即使 O2 已完成，也不能跳过 a–b 的缺口。若 c 的发生时间早于 a，接收顺序仍确保 c 被发现。

验收还应覆盖重复 tick、超过单页上限、相同发生时间、defer 后无新消息、映射冲突和两个 worker 并发提交。断言观察范围、成功事实和水位，不以等待固定时长代替完成条件。

未采用“每 tick 一次 observation”，因为它把通知频率变成语义边界；未采用“按事件时间取最近 N 条作为消费水位”，因为迟到消息和分页会破坏完整性；未采用“所有模块共享一个已处理指针”，因为后台形成和行动完成具有不同失败边界。

实现与迁移跟踪在 [#247](https://github.com/posanbu/Kaguya/issues/247)；跨领域检视与完整时序验收见 [#250](https://github.com/posanbu/Kaguya/issues/250)。
