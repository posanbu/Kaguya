# 真人参与预测：离线工具

本目录交付 [#278](https://github.com/posanbu/Kaguya/issues/278) 的首轮离线流程：冻结群聊事件、生成历史截点与自动标签、运行历史统计基线、输出逐样本及分组报告。Python 3.10+ 标准库即可运行，全部命令只访问本地文件。

提交的 `example-events.jsonl` 是 **86 条虚构事件**。身份、正文、群、覆盖缺口均为合成数据，用于验证流程。示例中的预测分数表示流程计算结果。真实群聊采集与模型对照接入见文末。

## 运行

在仓库根目录执行；每个输出目录必须尚不存在，包括空目录。Windows 可将 `python3` 换为 `python`。

```bash
python3 -m unittest discover -s benchmarks/participation -p 'test_*.py' -v

python3 benchmarks/participation/bench.py prepare \
  --source benchmarks/participation/example-events.jsonl \
  --config benchmarks/participation/example-config.json \
  --output .data/participation/dataset

python3 benchmarks/participation/bench.py preview \
  --dataset .data/participation/dataset \
  --output .data/participation/preview

python3 benchmarks/participation/bench.py evaluate \
  --dataset .data/participation/dataset \
  --output .data/participation/report
```

`preview/requests.jsonl` 给出候选实际能够读取的完整输入。此命令只打开输入和清单，标签文件与来源索引可在另一权限域保存。`evaluate` 使用独立标签评分。源码不读取 API key，不提供网络请求或模型执行入口。

原始日志、身份映射和输出保留在被 Git 忽略的 `.data/`。程序在 POSIX 创建 0700 输出目录、0600 文件；Windows 的访问控制由运行账户 ACL 管理。工具接收已正规化的稳定身份，真实数据导出方负责稳定伪名及身份映射的私有保存。

## 输入协议

协议为 `kaguya-participation/v1`，事件及配置的 `schemaVersion` 为 `1`。配置参见 `example-config.json`：

| 字段              | 含义                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `dataKind`        | `synthetic` 或 `private`；决定报告的数据用途标识                  |
| `targets`         | `scope` 与稳定 `userId` 的组合；同一语料可配置多个人、多个群      |
| `scope`           | `platform`、`adapterId`、登录 `accountId`、`groupId` 四个非空字段 |
| `blocks`          | 共享时间块 ID、`history/dev/test`、带时区的 `start/end`           |
| `recentMessages`  | 近期上下文条数，默认 20                                           |
| `minGroupSamples` | 统计分组的最小训练样本数，默认 5                                  |

时间块必须有序、互不重叠，依次包含 history、dev、test。同一时段的多目标、多群共享 block ID；重叠截点保留共同 block ID。首轮不计算把这些截点当独立观测的置信区间。

JSONL 每行是一个记录。公共字段为 `recordId`、`captureSeq`、`schemaVersion`、`scope`、`eventType`、`occurredAt`、`receivedAt`。记录 ID 全局唯一，接收序号严格递增，接收时间不回退；时间使用带时区 ISO 8601，内部转换为 UTC 整数微秒。平台发生时间可以较早。

| `eventType` | 专用字段与行为                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `message`   | `platformMessageId`、`senderId`、`text`；可选 `senderName`、`mentions`、`mediaTypes`、`replyTo` |
| `recall`    | 同范围内被撤回的 `platformMessageId`；从撤回到达的位置开始遮蔽原正文及媒体                      |
| `coverage`  | `start/end` 与 `status=complete/gap`；区间末端不得晚于该记录的接收时间                          |

`replyTo` 保存 `{scope, platformMessageId}`。引用仅在源消息到达时解析已知同群消息；跨群或未知引用保留 `unresolvedReply=true`，未来到达的正文不补入旧引用。自身消息由 `senderId == scope.accountId` 识别。

重复的同范围平台消息 ID 只产生一次发言和事件截点，后到记录仍写入来源索引并标为 `duplicateOf`。正文、发送者、发生时间、引用、媒体或显示名发生冲突时拒绝整个导入。未知事件需由采集正规化器先分类处理，工具会报错。原始凭据、action 回执和未知 frame 不属于本协议。

`complete` 覆盖区间可拼接；`gap` 优先于重叠的完整声明。缺少覆盖声明的部分视为未观察。缺口采用 `[start,end)`；完整区间可证明观察到末端。覆盖是导出方作出的观察声明，首次写出整段完整区间前应确认连续采集与持久化已完成。

## 截点与标签

每条去重后的消息到达后建立一个事件截点。每个 block 从起点开始每 30 秒建立一个时间截点；同一时刻的时间截点位于该时刻所有已接收事件之后。事件截点用接收序号区分相同时间戳下的先后。两种截点分别保留，`cutoffKind` 标明来源。

最大标签窗口末端必须严格早于 block 的半开区间末端，否则整个截点被排除，并计入 `splitBoundaryCutoffsExcluded`。由此 30 秒与 120 秒标签共享样本集，窗口完整留在所属 split 内。

参与标签取截点后、窗口末端及之前收到的目标新消息。同时间戳但序号更高的消息可以成为延迟为零的未来发言。迟到消息以实际接收位置进入历史与参与标签。`opportunityKind=continuation` 表示截点最后一条消息由目标发出，其余为 `joining`；此字段描述前缀状态。

- 已观察到目标发言：`participates=true`，即使窗口含缺口。
- 完整观察窗口且没有目标发言：`participates=false`。
- 其余情况：`participates=null`、`status=unknown`，保留连续观察的上限。
- 只有截点至首条目标消息之间覆盖完整，才给出首次等待秒数及其间其他成员消息数。其余保留 `delayStatus=censored`。

撤回不抹去已经发生的参与事件；正文在后续输入中按撤回位置遮蔽。媒体仅保留类型，其内容没有进入文本输入。`senderName` 是各条历史消息自带的显示名，不通过当前账号信息更新旧快照。

## 统计基线与扩展接口

`ParticipantPolicy.predict(frozen_input)` 返回 `{"30": p30, "120": p120}`。两个概率均须为有限的 `[0,1]` 数值，且 `p120 >= p30`。每次调用获得输入副本，不接收标签。接口独立于生产 Light/Planner 动作协议。

`HistoricalPolicy` 只用 history 段两个窗口均覆盖完整的样本拟合。它先按目标与群分开，再按以下历史特征分组：

| 特征             | 固定规则                                                        |
| ---------------- | --------------------------------------------------------------- |
| 直接寻址         | 最近 30 秒其他成员对目标的 @ 或已解析的引用                     |
| 最近目标发言间隔 | `<30s`、`30–120s`、`>120s`、此前未出现                          |
| 群活跃度         | 最近 120 秒消息数 `<5` 或 `>=5`，含自身消息及后来撤回的参与事件 |

分组样本数达到 `minGroupSamples` 时使用分组统计，否则回退至该目标、该群的总体参与率。每个窗口使用 `(正例数+1)/(样本数+2)`；同一训练样本集保证双窗口概率单调。没有 history 样本的目标使用 0.5 先验并标为 `untrained_prior`。此处频率按截点计数，样本依赖由 block ID 保留。

dev 按目标、群、窗口独立最大化 F1，同分取较高阈值。dev 缺少任一类别时使用 0.5，并记录原因。test 固定拟合统计和阈值；历史前缀可继续包含已经发生的 dev/test 消息。history 报告标为拟合诊断，dev 标为阈值选择，test 标为 held-out。

`MemoryAdapter.build(scope, watermark, earlier_history)` 接收近期预算之外的旧历史，返回绑定范围和水位的 checkpoint；`recall(checkpoint,target)` 返回带 `sourceIds` 的证据列表。工具要求证据引用当前截点更早的同群记录。首轮的 `EmptyMemory` 返回空证据，checkpoint 绑定旧历史哈希。后续 adapter 在独立实验空间重建记忆；接口本身是数据访问约定，不是运行任意插件的安全沙箱。

## 输出与指标

| 文件                       | 内容                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `dataset/inputs.jsonl`     | 冻结输入、目标角色、特征、Memory checkpoint、block 与来源水位 |
| `dataset/labels.jsonl`     | 参与标签、首次发言、等待时间和覆盖质量                        |
| `dataset/sources.jsonl`    | 每条原始记录的哈希、接收位置与去重关系                        |
| `dataset/config.json`      | 补齐默认值的冻结配置                                          |
| `preview/requests.jsonl`   | 完整候选输入，字节内容与冻结输入相同                          |
| `report/predictions.jsonl` | 逐样本概率、成功/失败状态、特征、历史样本数与回退来源         |
| `report/summary.json`      | 训练统计、dev 阈值、逐目标/群/窗口/split 指标                 |
| `report/runtime.json`      | 逐次本地预测耗时，单独存放                                    |

每个工件目录的 `manifest.json` 采用与 fast-policy 一致的 `schema_version`、`source_sha256`、`dataset_sha256` 字段，并增加协议、代码哈希和工件哈希。样本 ID 绑定 corpus、配置、范围、目标、block、截点与接收水位。相同字节来源及配置产生相同样本、标签和清单；runtime 计时不参与确定性哈希。写入中保留 `incomplete.json`，完整写入后移除；后续读取拒绝半成品或被修改的工件。

主报告采用自然截点分布，报告正例比例、已知/未知标签、覆盖不完整、成功/失败与等待截尾计数。PR-AUC 使用 average precision，相同概率的预测整体处理 ties。另给 Brier score、precision、recall、F1 及混淆计数。空集或单类别组的指标为 `null` 并记录原因；混合类别但没有预测正例时 precision 为 `null`、recall/F1 为 0。

预测失败始终计入 `attempted/failures`。有已知标签的预测失败时，全量指标为 `null`、原因是 `prediction_failures`；成功子集的指标单列在 `completedOnly`，其样本分母同时保存。未知标签只进入质量计数。首轮不预测首次发言时间，因此时间误差保持 `null`，同时报告 120 秒观察范围内的等待标签计数。

## 下一阶段的采集接口

NapCat 采集与一致性冻结工具已接入现有连接，配置、覆盖定义、恢复和导出命令见 [采集说明](CAPTURE.md)。下面保留采集验收约定。

NapCat 采集器应输出上述正规化事件，并满足：

1. 独立的采集群范围及开关，保留全部可观察成员发言、自身消息、撤回、@、引用和媒体类型；采集权限与推理、发送权限分别控制。
2. 登录身份、群范围与连接代次校验；跨重连使用同一平台消息键，持久化单调接收序号和重启检查点。
3. 连续覆盖声明来源可审计；断线、队列溢出、重启和磁盘失败形成明确 gap。所有未支持事件有分类统计。
4. 采集故障不阻断现有消息链；仅采集模式不启动新增模型调用或生产 Memory 写入。
5. 私有保存原日志及身份映射，离线导出稳定伪名。真实采集、模型正式评测和真实语料公开分别通过明确入口执行。

共享冻结/manifest 约定供 #181 与 #274 后续接入。模型运行前仍需提供服务商、数据范围和完整请求预览，并取得单独授权。
