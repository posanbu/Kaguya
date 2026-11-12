---
title: 决策与行动生命周期
description: 冻结观察上的自然互动决策、新信息干预和外部副作用边界。
---

# 决策与行动生命周期

框架无关的[行动连续性](../situation-model/continuity)和[更新与恢复](../situation-model/recovery)定义整个 Agent 的主行动线、依据保留和检查点。本页保留 Kaguya 的能力边界、竞态样例与协议迁移。切换 scene 不等于重置 Agent 的行动历史。

本文回应 [#243](https://github.com/posanbu/Kaguya/issues/243)，属于[持续情境契约](./)。当前持久执行接口见本页末节，其余场景按各能力逐步接入。一次判断可以引用多个 tick 所形成的 observation；消息、工具和设备复用来源关系，按各自能力声明执行与取消规则。

## 从观察到结果

Decision 固定所用 observation、Memory revision、策略版本和判断原因。Action intent 引用产生它的 decision，记录目标、参数、权限依据、依赖及稳定执行身份。执行结果引用对应 intent 和执行 attempt，并以新的 Information 回到明确相关的 scene。

一个 decision 可以派生多个有依赖关系的 action，但 observation 完成、decision 完成、action 排队、开始执行、结果确认分别是不同事实。模型完成不能代替副作用完成，delivery/tool result 也不能代替后续对结果的理解。结果是否产生新 tick 由 Kind 和 scene 关联规则决定，重复状态投影不应反复唤醒系统。

## 三种自然互动结果

**Message** — 判断决定生成消息意图。Heavy 仅在此路径生成正文；生成后还要经过发送前有效性和授权检查。Decision 成功不意味着已经投递，外部结果单独记录。后续支持工具/设备时使用能力专属 intent，不强塞进 message 正文或伪造投递记录。

**Wait** — 已完成本次判断，主动等待更多证据、依赖结果或指定时间。记录原因、等待范围、到期条件、预算及稳定 schedule 身份。满足条件后创建后续判断并引用原 wait，超时也产生可解释结果。观察进度保留，等待不能靠回滚“已读”实现；重复恢复不产生多个有效 timer 或重复行动。

**Silent** — 当前判断决定不采取外部行动。记录原因及证据，不生成隐式回复；后续新 tick 仍可唤醒。它不阻止独立 Memory 形成，也不意味着消息未被读取。

需要区分自然选择和降级路径。当前 Light 在模型不可用时可能输出带 `light-unavailable` 原因的 silent；检视应显示为降级静默并关联模型失败，不能以“无动作是正常结果”为理由隐藏失败。Wait budget 耗尽同样保留原因。

## 新信息在什么阶段生效

冻结后到来的信息总是进入后续 observation，不修改已持久的旧 decision 输入。它可以触发对旧行动有效性的检查，但不能仅因“有新消息”就无条件取消一切工作。检查记录触发来源和规则版本；明确更正、停止请求、权限变化或原依赖失效与无关插话应区别处理。

**规划中** — 若新证据使旧问题或目标失效，记录旧规划被替代，由后续 observation 重新判断。旧模型调用可以尝试取消，但即便仍返回，其结果也不能再次派发已失效 intent。无关信息允许旧规划继续，后续判断保留已在处理的任务状态，避免重复行动。

**排队中或正文生成中** — 副作用开始前校验 intent 当前版本、替代/取消状态、依赖和权限。取消与 dispatch 竞争时，以持久状态的原子比较决定胜者；worker 持有租约还不够，真正派发时仍需验证有效执行身份。若取消胜出，迟到 Heavy/Light 输出只留作诊断，不产生发送请求。

**执行中** — 根据能力处理。可取消任务发出取消请求，收到执行方确认后才记录 cancelled；已部分执行则记录已发生部分和剩余部分状态。不可取消或已完成的行动保留事实，通过新判断决定是否补充或补偿。补偿是有来源的新 action，也需要授权，不能修改历史结果假装原行动没发生。

**结果不确定** — 请求已发出但确认丢失时记录 unknown，按能力提供的查询、回执或幂等键核对。只有执行方支持相同操作幂等、确认未执行或明确的重试策略时才重新派发；不保证所有外部系统恰好执行一次。执行已经获胜后才到达的取消，不得被记录为“成功阻止了副作用”。

因此消息发送、长工具任务、语音播放和硬件控制共享可追溯生命周期，但不强制采用统一抢占策略。每个能力必须声明能否取消、成功的证据、幂等边界及结果不确定时的恢复方式。

## 当前协议映射与迁移

当前 [`Router`](https://github.com/posanbu/Kaguya/blob/ff5544603f528601b7a8930cf0396199691de4c2/packages/modules/src/first-party/router/index.ts)已消费冻结 turn context，持久化 Light decision、派发 message/wait/silent 并处理 delivery terminal；已有 interrupted、superseded 等终态和持久任务可以作为起点。存在这些 Kind 不代表所有工具、设备已经遵守上述竞态与取消契约。

迁移先为现有 decision、message intent、model task 和 delivery 的关联补齐版本与检查边界，并在兼容投影中显示不同进度。保留 `agent.router.turn.*` 名称和旧 payload 读取；新能力通过独立版本化契约接入。历史 `turn.completed` 只按旧协议解释，不扩展成“所有外部行动和记忆均完成”。

初期先验证消息和一个可控工具的执行边界；TTS/设备按各自后续任务接入。本文的 live/语音时序是验收要求，不表示当前 Kaguya 已具备全双工语音能力，也不把 TTS 合成成功当成播放成功。

## 群聊更正时序

O1 包含 A 的提问、C 的插话和 B 的「已经戒了」，D1 决定发送消息。B 的更正在正文生成时到达，形成 O2。若它推翻待发送内容，D1 的 intent 在发送前被替代，D2 引用 O1、O2 决定重新表达、等待或沉默；D1 的迟到正文不得发送。

如果旧消息已经成功发送，O2 保留这一事实，D2 可选择补充更正；如果发送请求已出但结果未知，先记录 unknown 并核对，不直接重发。重启后 D1 仍只能有一个有效派发身份，D2 也不能根据缺少终态推断原消息一定未发送。

验收覆盖新信息分别落在规划、Heavy、排队、dispatch 竞争点及回执丢失阶段，并测试无关插话不会无条件取消有效任务。每一步检查来源、版本、持久状态及真实模拟执行次数，不仅断言生成了新回复。

## Live / 语音时序

语音片段 S1 到达并形成 O1；后台工具 T 开始执行。用户补充 S2「先别查了」，形成 O2 并触发取消请求。若工具支持取消，等待其确认；若结果先到，按已完成记录，不把迟到的取消确认覆盖成“从未执行”。D2 根据实际结果和新要求决定是否回应。

若 Agent 此时正在播放回答，停止播放是独立 action。播放方报告停止位置和已播放范围；已合成但未播放的内容不能写成对方已收到的经历。稍后模型或 TTS 返回旧结果时，通过 intent 有效性检查阻止继续播放。未提供播放回执的能力只能保留结果未知，不能自行声称已经停下。

这条时序用合成语音事件、可控工具和播放回执验证生命周期，再由真实适配器独立证明端到端效果；协议测试不替代实际听感、打断时延或设备验证。

## 未采用的方案

未采用“每条新信息都打断当前行动”，因为群聊旁支会使有效工作持续饥饿；未采用“规划开始后忽略所有新信息”，因为更正、停止和授权变化可能使行动失效；未采用“取消网络请求就等于取消 action”，因为外部副作用可能已经发生。重试策略按能力与执行状态确定，不能由前端 HTTP 库的默认重试代为决定。

实现与迁移跟踪在 [#249](https://github.com/posanbu/Kaguya/issues/249)；跨领域检视与完整时序验收见 [#250](https://github.com/posanbu/Kaguya/issues/250)。

## 持久执行接口

`agent:action` capability 提供 `register`、`execute`、`cancel`、`supersede`、`reconcile`、`read` 和 `readReceipt`。原生工具与 MCP 适配器通过宿主注册 `ActionProvider`，声明取消、幂等、核对、成功证据和环境隔离能力。宿主签发包含完整执行规格摘要的精确授权，绑定工具名、provider 版本、环境和动作依赖；模块只能引用已有授权，不能通过 capability 自行批准操作。

Intent 固定 `operationId`、run、decision、observation、Memory revision、原始来源、provider/version、目标、参数和环境身份。同一操作键与相同参数返回原 intent；参数变化产生冲突。`agent.action.decision.v1` 是工具决策的公开 Kind；已有 Light message decision 继续使用原协议。

执行资格在同一事务内裁决：先取得 Memory 发布锁 `7149321`，再锁 action 行，随后使用 READ COMMITTED 重新读取冻结依据的当前有效性、授权和依赖。`checkDependencies` 仅供诊断。宿主在授权前调用 `dependenciesFor(observationId, evidenceInformationId)`，从实际输出的持久因果链重读模型请求；后继提示中的 `memory_recall` 与原召回事实逐项核对，补充 revision 与来源并入执行依据。此入口也供工具步骤复用。Frozen Memory 的历史来源与 pending evidence 都参与检查；后续 revision 移除来源不会使原来源撤回失效。`started`、attempt 与 outbox 同时提交，provider I/O 在事务外进行。

**取消与恢复** — 取消先记录请求，provider 确认后追加结果。`partial` 和已核实的结果不会被迟到 `unknown` 覆盖；所有回执仍保留。启动和运行中的有界周期扫描将已开始但租约过期的动作恢复为 `unknown`；重启时仍有效的 lease 保留到期后再处理，无需新输入。再次 `execute` 不重发。调用方使用当前控制授权调用 `reconcile`，查询原 operation/attempt；核对采用独立预算，不继承已经过期的执行期限。

**环境与凭据** — Intent 仅保存环境、generation、workspace、资源范围、workflow、lease ID 和 fencing 序号。宿主在调用前解析内部凭据，凭据不写入 intent 或回执。环境准备、执行与结果核对共享一次调用的绝对预算。Provider 必须在实际入口验证租约及取消 tombstone；Linux 环境可通过下述 broker 适配；其他环境按 provider 能力另行接入。接管后的历史回执保留原 attempt 的效果与产物，并以 `environmentValidation` 记录当前、已隔离或未确认状态。这项记录不授权继续操作；数据库 claim 失效仍拒绝旧执行器提交。

**回执读取** — 回执是独立、不可变的 Information。`readReceipt` 校验当前控制授权、scope、intent 摘要、started/attempt 来源链、结果摘要和产物归属，返回原始登记位置。后续 Memory 消费方应通过此接口重读，不能把模型转述当成执行证据。回执到 Memory 的来源桥接由独立模块完成。

**消息兼容** — Runtime 在现有消息发送前使用同一 admission，并在运输入口复核目标授权。已保存 action 结果但旧 delivery 投影丢失时，从持久结果恢复，不再次发送。NapCat 超时、连接中断和未证实的失败回执记录为 `unknown`。没有完整 observation 的历史消息保留显式 `legacy:` 依据标识，不补造冻结证明。

Schema 以新增 action 授权、run、head、receipt 和 outbox 表的方式增量初始化，不删除旧表或改写历史 turn payload。当前测试使用受控 provider 验证真实执行次数，并覆盖 PGlite 与 PostgreSQL；Linux broker 协议另有持久 journal 与实际 SO_PEERCRED 测试；真实容器镜像、桌面、TTS 和设备分别完成实际环境验收。

## Linux 隔离工具环境

宿主可通过 `LinuxEnvironmentClient` 连接专用账户的 Unix broker。将 `client.provider()` 注入 `RuntimeOptions.actionProviders`，将 `client.actionHooks` 注入 `RuntimeOptions.actionEnvironment`；环境管理 API 由宿主调用，不自动开放为模型工具。`acquire` 返回公开环境引用，私有 token 仅保留在客户端内存与 socket 请求中。安装入口与完整 helper 合同见仓库 `scripts/linux-environments/README.md`。

broker 在真正派发处复核 scope、workspace/resources、workflow、generation、fencing、lease 与 token。固定 operation/attempt/digest 与参数；取消先到会持久化 tombstone，未知结果不重派。单次 permit 截止取操作 deadline 与派发时 lease 到期时间的较早者，renew 不延长旧 permit。镜像内部服务负责在每次实际输入前核验 permit，broker 在收集超时后隔离整个环境。

人工接管 `handoff` 关闭旧自动化输入，收到内部确认后推进 generation，保留桌面和未保存内容；`resume` 再次推进代次并要求新 lease 与新观察。故障恢复 `recover` 停止旧容器、确认无运行 PID 后重建，保留 workspace。历史回执和产物始终保留原 attempt/generation。`reconcile` 只读 broker journal，外部文件、job 或站点状态需要新 lease 下独立 verify，再将证据接回 W3。

安装目标为 Ubuntu 26.04 x86_64、systemd、cgroup v2 与专用 rootless Podman。容器使用固定镜像 digest、只读 rootfs、命名工作卷与独立进程/网络空间；默认无网络，显式 public-web 由专用 UID 规则限制出口。容器存储为预分配 24 GiB ext4，broker 状态为独立 4 GiB，产物受单次 16 MiB 与累计 2 GiB 约束。每次采集拥有独立产物身份，内容 hash 可去重；附件超限保留已返回 outcome 与 workspace 回执，并标记 truncated。

当前实现包含安装脚本、broker、宿主适配与受控后端测试。管理员 bootstrap 由用户在 Linux 本机执行；W7/W8 的完整镜像、Chromium sandbox、GUI 输入隔离及实际网络边界仍须独立验收。
