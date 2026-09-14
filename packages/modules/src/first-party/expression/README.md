# 聊天表达习惯

## 目的与非目标

从真实聊天归纳可复用的场景与语言表面形式，独立于 Persona、事实 Memory 和 Planner。当前使用严格的场景与风格枚举，包括短句、反问、先回应再补充、语气词节制等；不保存任意句式原文，也不模仿某个具体用户。

## 消费和产生

消费 Identity 的真实 canonical scope 终态，后台冻结 learning.requested 并产生 learning.completed。消费已获胜的 message intent，先冻结 selection.requested，再产生 selection.completed；无候选也会产生空选择。Composer 只消费已冻结选择。

## 数据流与边界

学习来源只包括真实用户入站，拒绝自身发言、媒体占位、系统内容和噪声。scope 必须来自真实 Identity 实体且与目标一致；不存在 fallback ID。每条模式保留来源 Information ID。选择上下文绑定冻结 turn 与 message intent，至多注入三条。

Composer 使用独立 expression_habits 变量，provenance 指向选择结果及来源批次。提示明确要求自然匹配时才参考，不能改变事实、动作、授权或目标。受限枚举拒绝人名、账号、长原文和私密事实进入表达库。

## Settings

batchSize 默认 8，范围 2–24。默认实例 expression.default；通过 kaguya:expression.ready 声明 Composer 的流水线依赖，避免关闭模块后静默丢失回复。

## 可靠性、幂等和失败行为

请求先冻结真实来源与版本，再调用通用 Model Task。批次以持久化位置水位推进；相同请求复用模型任务。学习结果整体通过结构、来源验证后以唯一终态提交，非法结果保存 rejected 和空习惯，失败或取消正常闭合。相同 scope、场景和风格使用稳定 ID，计数以唯一来源集合聚合。

选择请求冻结候选，输出必须是该集合的至多三个唯一 ID；非法结果、失败或取消降级为空。持久化失败由 durable delivery 重试。重启恢复账本请求和终态，不把进程内缓存当作事实来源。召回最近 100 个已完成批次，最多 24 个候选，计数表示该有界召回窗口中的唯一来源数。

## 日志与可观测性

普通日志只有状态、原因和条数。Inspection 可以沿 caused-by、uses-context、status-of 查看真实来源、抽象模式、冻结候选与选择结果；完整内容仍走现有显式诊断访问。

## 典型场景

一个群在解释问题时经常采用短句，学习批次归纳该模式。下一次类似讨论进入 message 决策后，选择模型可选中它，Composer 自然缩短句子；轻松闲聊与其不匹配时选择空集合，沿用当前 Persona 与冻结事实生成。
