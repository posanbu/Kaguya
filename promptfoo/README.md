# 对话行为评测

## 人物认识端到端对照

`portrait-behavior.yaml` 比较基线模板和改进模板。七个合成情景覆盖隐含科研线索、线索不足、第三方转述与玩笑、历史与当前活动、身份更正、同名人物和私聊隔离。评测从原始对话形成认识，不预填人物画像。问题的 `review` 仅保存在结果中，不进入模型输入。

每组使用独立的内存 PGlite 数据库，运行生产来源归一、形成 Prompt、输出校验、版本发布、冻结读取与主动补查。形成使用指定 profile 的 Light 模型，回复使用同一 profile 的 Heavy 模型。基线与改进组只替换默认模板，运行代码、原始对话、模型和每次调用预算相同。两组均忽略 local 模板覆盖。

先准备独立基线模板目录。例如，从实现前的主线提交导出：

```sh
mkdir -p /tmp/kaguya-portrait-baseline
git archive 02ab48e0d8850f7eb07d69a36a5bece79f3a4c1a packages/modules/templates | \
  tar -x -C /tmp/kaguya-portrait-baseline
pnpm exec tsc -b
KAGUYA_EVAL_PROFILE=/absolute/path/to/profile.json \
KAGUYA_EVAL_BASELINE_TEMPLATES=/tmp/kaguya-portrait-baseline/packages/modules/templates \
PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 \
pnpm exec promptfoo eval -c promptfoo/portrait-behavior.yaml \
  --no-cache --output /tmp/portrait-comparison.json
```

此入口调用外部模型服务并产生费用。每次固定 `temperature=0`、`max_tokens=8192`、60 秒超时。配置文件将两组推理强度都固定为 `minimal`，用于比较模板。若需复查 profile 的实际推理设置，将两组 provider 的 `config.reasoning` 同时改为 `profile`。该模式沿用各 tier 的 `generation.reasoning`，`none` 和 `provider-default` 与生产适配器一样不发送 `reasoning_effort`。不同推理设置的结果分别报告。每组每情景最多调用 24 次。每个回答最多六次模型调用，其中主动补查最多两次，接续不重置额度。实际调用次数可以不同，需单独报告。形成按场景阶段强制分批，不复现生产调度或墙钟等待。回复接续使用简化调度。评测仅写独立内存库，不写生产账本或发送平台消息。

结果保留来源及已有认识、原始模型输出、发布结果、实际回答、补查、历史重读、最终 Prompt、模板及场景哈希、模型、参数、调用次数、token 用量和耗时。缺失用量记为 `null`。失败保留部分结果并计入失败分母，拒绝发布的内容不进入回答。历史重读核对的是发布版本，待形成原话不作为历史查询的补填内容。

自动通过只表示输出协议、发布和读取流程完成。人工逐例检查以下内容，并分别记录形成质量与回答质量：

- **认识与依据** — 是否综合线索，结论的具体程度是否合适，是否保留合理的其他解释。
- **回答与使用** — 是否回答“这个人是谁、近期忙什么”，是否自然承接，而非复述发言清单。
- **更新与归属** — 更正是否改变后续回答，是否混淆说话者、同名人物或活动时间。
- **范围与历史** — 私聊推断是否留在原范围，后来的更正是否进入旧版本。

比较时核对两组场景哈希、模型、参数和模板版本。分别报告形成完成数／全部形成尝试数，以及回答完成数／全部计划问题数。人工评价保留具体样例和判断依据，不把结构通过率当作人物理解分数。合成情景不是独立真实群聊样本，实际效果仍需真实交流验收。评测输出和含凭据的 profile 不应提交仓库。

2026-11-13 的实现检查、实际失败和逐例审阅见[首轮结果记录](./RESULTS-PERSON-INFERENCE-20261113.md)。

## Light 参与判断

`pnpm prompt:test` 仍是离线结构回归。`light-behavior.yaml` 是独立的联网评测入口，会调用指定 profile 的 light 模型，产生模型费用，但不会接入运行时账本或发送群消息。Provider 使用 [promptfoo 自定义 Provider 接口](https://www.promptfoo.dev/docs/providers/custom-api/)。

## 评测内容与证据边界

评测针对 [#211](https://github.com/posanbu/Kaguya/issues/211) 的职责划分：进入 Light 只代表查看会话，是否参与由 Light 结合上下文决定。模板要求先确认对话对象和新增交流价值，区分已回答的同义评论、新的直接追问、待补全请求与无需参与的闲聊。等待预算只限制继续等待，不禁止回答已完整的问题。

案例来自 2026-09-21 kaguya 服务器的 journal 和持久化 `core.model.task.requested.prompt.variables`。20:50:18 的规划输入中已经包含 20:50:14 成功投递的回复，但随后仍生成近义评论。该记录支持检查语义重复，不能单凭日志判断所有主动发言都不合理。

三个日志案例保留冻结历史与输入顺序，将说话人和引用 ID 匿名化，去除链接、分享密码、记忆和人物投影；另有十七个合成边界案例（含兴趣归属、同名发言者、已核验引用、多话题选择、情绪回应及已解决请求）。匿名化引用正文只保留引用标记，不保留原始 ID。它们是人工制定目标的诊断集，不是完整生产重放，也不是随机抽取的独立测试集。`log-title` 和 `log-share` 的静默标签表达本次减少无内容插话的目标，并非唯一合理答案。

评测将冻结变量交给生产模板渲染器，并附加生产 JSON 输出协议。模型输出必须通过当前本轮动作 schema 与等待预算检查，再与预期动作比较。Light 不生成焦点。没有模型裁判，也不自动修复非法 JSON。模型使用 OpenAI-compatible JSON object 请求，固定 temperature=0、单次超时 120 秒，不执行生产端的结构化失败恢复。生产端生成参数与服务调度不同，因此这里的通过率不能直接等同线上成功率。

运行时在结构修复阶段拒绝超预算 wait；失败时仍会记录 `silent / wait-budget-exhausted` 兜底。本评测不执行结构修复，原始非法输出直接记为失败，避免恢复机制掩盖模型未遵循契约。

历史对照结果保留在 Git 中：[2026-09-24 Light 评测](https://github.com/posanbu/Kaguya/blob/a0a565a21279f4fac72e1fd381323c101e50af65/promptfoo/RESULTS-211-PLANNER.md)和[早期 #212 评测](https://github.com/posanbu/Kaguya/blob/a0a565a21279f4fac72e1fd381323c101e50af65/promptfoo/RESULTS-211.md)。后者的 22/24 仅属于当时的 Light 提示词实验。后续 #222 已移除 Arousal 的语义评分；当前实现进一步补充数据库角色设定、多人背景、引用正文及本轮动作约束。这里仍只评测冻结输入到模型输出，检索正确性、持久化和重放由独立测试覆盖，不把本评测当成线上整体效果。

## 运行方式

先安装依赖并完成 `pnpm exec tsc -b`。运行联网评测必须显式指定评测 profile；profile 内含服务商配置，不能提交进仓库。建议在独立工作目录使用仅用于评测的 profile。服务端执行可读取已经授权的现有 profile，密钥无需复制到本地。

```sh
KAGUYA_EVAL_PROFILE=/absolute/path/to/profile.json \
PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 \
pnpm exec promptfoo eval -c promptfoo/light-behavior.yaml \
  --no-cache --repeat 2 --output /tmp/planner-candidate.json
```

默认读取仓库的 `light.decision.default.hbs`，刻意不读取 local 覆盖以保证评测版本明确。可用 `KAGUYA_EVAL_TEMPLATE=/absolute/path/to/baseline.hbs` 比较历史模板，或用 `KAGUYA_EVAL_SOURCE_ROOT` 指向已构建源码根目录。两组对照必须使用相同案例、模型、参数和模板变量，保留服务错误及非法响应作为失败分母。

评测完成后按案例比较各次结果，不能只报告平均通过率。原始评测输出、真实日志、profile、local 模板及分享凭据不应提交进仓库。模板在服务器生效需要遵循对应版本的模板加载和配置应用方式；本地 default 的变化不会自动更新已有 local 覆盖。

## 持续活动的实际环境验收

完成构建后，运行 `scripts/evaluate-continuity.mjs`。`KAGUYA_CONTINUITY_EVAL_OUTPUT` 指定私有结果目录。模型模式还需通过 `KAGUYA_CONTINUITY_EVAL_PROFILE` 指定已配置 Profile，沿用生产模型、生成参数、Model Task 和结构恢复路径。加 `--scripted` 使用确定性模型核对真实 Linux 环境，不能当作行为质量证据。脚本使用随机 PostgreSQL schema 和独立容器，不发送平台消息。

分别报告计划场景、全部模型尝试、结构恢复、失败、实际工具效果及 usage。没有价格配置时费用不可用。固定 RFC 工作区不替代生产 Linux broker、真实群聊及长期运行验收。原始冻结输入、完整尝试和笔记保存到忽略目录，不提交真实 Profile 或凭据。
