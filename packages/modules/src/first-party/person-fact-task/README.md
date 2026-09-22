# Person Fact Task

## 目的与非目标

通过结构化 Model Task 提取有证据的人物事实；不负责身份归一、记忆演化或回复。

## 消费和产生

消费人物事实候选及 Model Task completed，产生任务请求和验证后的人物事实。

## 数据流与边界

候选携带证据来源；模块把同一候选原子映射到 `person_id`、`name` 和 `candidate` 变量。Runtime 执行模型调用后，输出必须显式选择 `fact` 或 `insufficient-evidence`；只有 `fact` 分支会继续验证人物标识和原文片段，并登记领域事实。`fact` 必须是候选文本的连续片段。该约束证明文字有来源，不替代语义核实。

## Prompt 模板

默认模板位于 `packages/modules/templates/person-fact.default.hbs`。复制为 `person-fact.local.hbs` 可做不进入 Git 的本地覆盖，修改后需重启。

模板可零次或多次使用 `person_id`、`name`、`candidate`；只追踪实际使用的变量。模板不自动逃逸候选文本；如果更改 JSON 输出要求，仍必须与模块的严格输出 schema 保持一致。

## Settings

配置模型层级。Prompt 模板由调用该公共工厂的 composition root 注入。

## 可靠性、幂等和失败行为

等价候选共享稳定任务；非法输出和 `insufficient-evidence` 都不写入人物事实。显式弃答正常结束，不为填充空库重试或生成默认事实。模型不得从 persona、昵称相似或缺失信息推导人物事实，人物身份、事实片段与证据来源不一致时仍会被拒绝。

## 日志与可观测性

记录任务与提取终态，不在普通日志展开人物事实正文。

## 典型场景

后台消费者从明确候选中提取姓名或偏好事实并保留证据引用。
