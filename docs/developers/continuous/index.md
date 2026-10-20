---
title: 持续情境、记忆与行动契约
description: 持续 Agent 的领域设计、现有协议映射与分阶段实施边界。
---

# 持续情境、记忆与行动契约

框架无关的术语、双情境视图、上下文装配和行动连续性统一见[情境—行动上下文模型](../situation-model/)。本组保留 Kaguya 的实施任务、现有协议映射和迁移边界。新增模型规范不改变下文已经核实的实现状态。

本文承接 [#241](https://github.com/posanbu/Kaguya/issues/241) 和[持续 Agent 设计原则](../continuous-agent)。设计方向已在 2026-09-25 的人工评审中确认：先确定 scene、冻结快照与水位的公共契约，再分别落实 Memory 形成和行动生命周期。本文把这一方向落实为三个专题的设计结论、协议映射与可验证时序，已由 [PR #251](https://github.com/posanbu/Kaguya/pull/251) 合入。**规则属于目标设计，尚未由本次文档变更实现；设计合入与功能验收分别记录。**

当前行为核对基线为 [`ff554460`](https://github.com/posanbu/Kaguya/tree/ff5544603f528601b7a8930cf0396199691de4c2)。当前接口仍以[运行时架构](../architecture)、[Memory 认知层](../memory)和对应源码为准；本文的领域标识不自动成为新的公开字段或 Information Kind。

## 公共规则与 Kaguya 边界

证据不可变、冻结输入复用和独立进度的公共规则已迁至[对象与关系](../situation-model/objects)与[上下文装配](../situation-model/assembly)。未知结果、检查点提交和恢复规则以[更新与恢复](../situation-model/recovery)为准。本组不另存一套公共规范。

Kaguya 的 scene 映射群聊、私聊和 Web 入口，scope 继续表达授权读取范围。新术语不合并历史权限或人物身份，也不把一个群永久视为一个 episode。具体地址映射和兼容边界保留在[情境与观察](./observation)。

Information 持久化后可以形成 tick。Tick 是可合并的唤醒机会。来自工具、设备和 Agent 行动的结果必须声明 Kind、原 scene 关联和唤醒策略。Memory 后台独立持有形成进度，不能由前台 Arousal 的状态代为确认。现有持久任务可作为恢复基础，新增消费者的历史扫描仍由实施任务建立。

## 三份领域设计如何衔接

[情境与观察](./observation)定义场景映射、快照、水位和失败恢复，是三个议题共享的最小契约。[经历与长期认识](./memory-formation)定义后台如何跨多个 observation 形成、修订和召回经历。[决策与行动](./action-lifecycle)定义自然互动结果、行动授权与执行边界。

三个议题可以并行评审，但 Memory 和行动实现应以公共契约为前置。后台 Memory 可按自己的职责读取原始证据并建立 observation，不要求前台 Arousal 先决定开口或观察；两者复用范围与快照规则，各自确认进度。这样，Agent 保持沉默或暂缓互动时也不会永久失去形成经历的机会。

## 调研支持什么

[#242 的后台 Memory 调研](https://github.com/posanbu/Kaguya/issues/242#issuecomment-5827017791)支持把缓冲、后台形成、版本化修正和来源追溯拆成明确职责，也指出候选系统中的 episode 或 observation 未必等于一段群聊共同经历。本文采用这项问题分析，不宣布选定或验证了新的认知供应商。经历分段策略的实际质量仍需用群聊样本评估。

经历形成仍需明确来源层次：人物断言需要明确陈述者、主体、场景、有效时间和证据，不能从一次经历自动升级为全局永久画像。

[Web 检视调研](../research/)为本设计提供验收方法：领域 DTO 解释对象及状态，Trace 追溯已落盘的因果链，数据库工具供维护者检查存储事实。通用 Router、Server State 或表格库的候选建议不决定本协议，也不构成本文的实施依赖。浏览器请求取消与后端行动取消属于不同生命周期。

## 贯穿三个领域的验收

群 G 中依次发生：A 问 B 是否还喝咖啡；C 插话说自己在泡茶；B 延迟回复 A「已经戒了」；Agent 开始规划；B 更正「晚上不喝，白天还喝」。在更正前后分别注入进程重启、Memory 失败和投递结果不确定。

验收需要能回答以下问题，具体时序见三个专题：

- 每次 observation 的 scene、输入范围和记忆版本是什么？更正属于旧快照还是新快照？
- B 的答复如何关联到 A 的提问？C 的旁支是否被误归为 B 的偏好？引用缺失时是否明确保留不确定性？
- 经历哪个版本纳入了更正，旧认识如何保留修正轨迹，后台尚未完成时召回哪一版？
- Agent 选择 message、wait 或 silent 的原因是什么？旧行动继续、替代或停止的依据和执行阶段是什么？
- 重启后哪些范围仍待处理？同一形成任务是否只发布一次版本，投递是否被无证据地重复执行？

检视入口应能沿 scene → observation → decision/action 或 experience revision → 原始来源导航。缺失、截断、后台滞后和执行结果不确定都应显示为独立状态。真实浏览器用例验证导航和过期响应；服务端持久化测试验证恢复、并发和副作用，两种证据分别记录。

## 实施与迁移

本次迁移新增独立模型说明和库级装配契约，保留本组的项目实施关系、旧协议映射和验收时序。它没有把默认 Router 自动切换为一条全局行动主线。后续接入必须显式说明启用边界，并更新[实现映射](../situation-model/implementations)。

第一阶段实现 scene 映射、可恢复 observation 和各消费者进度；随后分别实现经历形成与行动生命周期；最后接通跨领域检视和贯穿用例。协议字段、数据库迁移和 Kind 版本应在对应实现 PR 中固定。

- [#247：场景映射、冻结观察与独立进度](https://github.com/posanbu/Kaguya/issues/247)。
- [#248：经历形成与长期认识巩固](https://github.com/posanbu/Kaguya/issues/248)，依赖 #247。
- [#249：行动有效性与执行生命周期](https://github.com/posanbu/Kaguya/issues/249)，依赖 #247，可与 #248 并行。
- [#250：领域检视与贯穿验收](https://github.com/posanbu/Kaguya/issues/250)，可先设计投影，完整验收依赖上述三个实现任务。

迁移采用增量方式：保留 `agent.router.turn.*`、现有 scope key、原始 Information ID 和旧 Memory；新增版本化投影与显式映射。旧 cognition 窗口没有证明完整经历，不自动转换成已验证 episode；旧投递记录也不推断未知的外部结果。回填、启用和回退必须有单独边界，不能只改名称就宣布行为完成。

设计 PR 已合并，项目状态为“领域设计已形成、实现待完成”；后续实现通过自己的验收后再逐项更新。#241 及子议题的人工验收、设计合入、实现完成和部署是四个分别核实的状态。

## 设计验收入口

[#244](https://github.com/posanbu/Kaguya/issues/244) 的身份、合并、冻结、连续进度、失败/放弃与恢复要求，对应[情境与观察](./observation)；其中的映射样例明确说明旧 Heartbeat scope 与 cognition key 为什么不能直接互换。

[#242](https://github.com/posanbu/Kaguya/issues/242) 的四层 Memory、真实输入、幂等/修正、既有模块迁移和群聊示例，对应[经历与长期认识](./memory-formation)。[#243](https://github.com/posanbu/Kaguya/issues/243) 的决策结果、执行阶段、新信息干预、协议映射与群聊/语音时序，对应[决策与行动](./action-lifecycle)。三个专题均记录未采用方案及其原因。

这完成了 #241 所要求的领域设计交付与实现拆分。主分支已有设计文档；#247–#250 的行为验收仍分别进行。具体 Schema、数据库约束、策略阈值、provider 适配和端到端效果属于实现验证，不能用本页或设计评审代替。
