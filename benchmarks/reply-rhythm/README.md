# 回复节奏离线评测

本目录对应 #274，评估一次回复是否回答明确问题，以及是否增加不必要的追问、建议或话题推进。#278 的参与时机和 Memory 检索效果继续使用 `benchmarks/participation`，两者分别报告。

仓库内的六个案例全部为合成数据，覆盖直接提问、接梗、抱怨、连续跟进、多话题和媒体缺失。每个案例有一条作者编写的短回复和一条多目的回复对照。它们验证评测工程，不代表真人对话或当前模型表现。实际真人短回复仍需在获授权的匿名材料中人工选取。

## 案例与输入

`cases.json` 使用 `kaguya-reply-rhythm/v1`。`input` 仅包含人格、观察截点、按接收时间排列的匿名消息和当前 turn 的消息 ID。当前 turn 必须是可见消息的有序后缀。说话人采用稳定 `person-*` 伪名。引用只能指向已观察到的消息。

`reference` 独立保存短回复、人工确认的关联消息和关联理由。`requiredAnswers` 保存明确问题及其输入来源。原消息与回复的关联须人工确认，不能仅由问号或相邻消息推断。`candidateInput` 只选取输入字段，参考回复、问题标注和采样说明都不会进入 Light/Heavy Prompt。

真实匿名案例标记 `dataKind: anonymized`、`reference.kind: human-reply` 和 `provenance.privacyReviewed: true`。该字段记录人工脱敏检查，不自动证明隐私清理完成。检查内容包括正文中的姓名、QQ 号、昵称、链接、分享凭据及可回认的语境。原始摘录和身份映射只放入已忽略的 `.data/`；本目录只接收完成审核的匿名案例。不要把合成参考改标为真人回复。

媒体消息保留 `mediaTypes` 和 `mediaContent: missing`。预览显式加入媒体内容缺失标记，不读取附件，也不声称模型理解未读取的图片。仅有媒体的消息正文仍填写缺失标记。

## 离线命令

从仓库根目录运行，无需 profile 或 API key。输出采用独占写入；每次使用尚不存在的文件名。

```sh
mkdir -p .data/reply-rhythm
node benchmarks/reply-rhythm/bench.cjs baseline .data/reply-rhythm/baseline.json
```

内置作者标注产生 12 条候选，其中 6 条含额外行动、3 条漏答，真人复核数为 0。`authored-fixture` 与 `human` 分开计数。这些数字是固定诊断数据的预期结果，不是模型得分。

组装预览需先构建仓库依赖，然后运行：

```sh
pnpm exec tsc -b
node benchmarks/reply-rhythm/bench.cjs preview benchmarks/reply-rhythm/cases.json .data/reply-rhythm/requests.json
```

`assemble.cjs` 复用生产 `compileLightPrompt`、`compileMessagePrompt`、当前动作 schema 和 JSON 输出协议。两条路径使用相同可见输入，Memory 关闭，固定匿名机器人身份，读取仓库 `.default.hbs`，不加载 `.local.hbs`。输出包含最终 Prompt、schema、变量来源、输入哈希、模板哈希和直接编译器源码哈希。该入口验证生产编译组件；不运行 Runtime、检索、工具循环或投递链，也不自动发起模型请求。

Promptfoo 使用同一组装入口，可由已有离线命令执行：

```sh
pnpm prompt:test -c promptfoo/reply-rhythm.yaml
```

Promptfoo 的通过仅表示请求编译成功。它没有模型裁判，不给回复节奏自动打分。

## 候选与人工复核

候选 JSON 数组中的每行包含 `id`、`caseId`、`inputSha256`、`variant`、`status` 和 `text`。`inputSha256` 必须原样保存自生成该候选时的组装预览；错误和超时也保留同一输入哈希。`status` 为 `ok/error/timeout`，空字符串表示静默。保持失败候选，不能从分母删除。修改同一 `caseId` 的可见输入后，必须重新运行候选；不能重填哈希把旧输出用于新输入。没有输入哈希的旧候选会被拒绝。`variant` 标识模板或模型配置；比较时固定案例、输入和生成预算。保存实际候选正文，不用参考短回复替换候选。

```sh
node benchmarks/reply-rhythm/bench.cjs review benchmarks/reply-rhythm/cases.json .data/reply-rhythm/candidates.json .data/reply-rhythm/reviews.json
```

复核者读取原消息、人工关联的参考回复和候选。逐条填写：

- `answers`：每个明确问题都必须标记 `answered/missing/uncertain` 并说明理由。
- `extraActions`：列出不必要的 `followup/advice/topic-extension`，填写候选中的原文片段和判定理由。没有额外行动时填空数组。
- `extraActionsAssessment`：完整检查后填 `complete`，不能确定时保留 `uncertain`。
- `reviewer`、`note` 和 `status: completed`：记录复核者、复核结论与完成状态。实际人工复核使用 `reviewKind: human`。

不要以字数阈值或逐字相似度替代语义判断。短回复也可能漏答，较长回复也可能全部必要。参考回复是节奏参照，不是唯一答案。若候选或案例发生变化，重新生成复核模板，原哈希绑定会拒绝陈旧复核。只改参考回复或评分要求时，可对输入未变的候选重新复核。错误和超时不接受语义复核，评分器不会把它们计作语义不确定或忽略附着的旧复核。

```sh
node benchmarks/reply-rhythm/bench.cjs score benchmarks/reply-rhythm/cases.json .data/reply-rhythm/candidates.json .data/reply-rhythm/reviews.json .data/reply-rhythm/report.json
```

报告分别给出漏答、额外行动、不确定、待复核、错误、超时、未覆盖案例及逐候选结果。每条结果保留案例、配置和输入哈希，便于核对错误归属。两种问题可以同时出现，不合并为单一分数。对照时按 `variant` 和案例查看逐条结果，不把重跑当作独立会话。

## 回归

```sh
pnpm exec tsc -b
pnpm exec vitest run benchmarks/reply-rhythm/reply-rhythm.test.ts promptfoo/reply-rhythm-provider.test.ts
```

协议回归覆盖哈希绑定、参考隔离、失败分母、明确问题全覆盖、未来输入拒绝及媒体缺失。生产组装回归逐案例核对编译器、输入保留、参考/评分信息隔离和零模型请求。所有异步编译直接等待 Promise，无固定休眠或后台队列。
