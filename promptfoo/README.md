# Planner 行为评测

`pnpm prompt:test` 仍是离线结构回归。`planner-behavior.yaml` 是独立的联网评测入口，会调用指定 profile 的 light 模型，产生模型费用，但不会接入运行时账本或发送群消息。Provider 使用 [promptfoo 自定义 Provider 接口](https://www.promptfoo.dev/docs/providers/custom-api/)。

## 评测内容与证据边界

评测针对 [#211](https://github.com/posanbu/Kaguya/issues/211) 的职责划分：进入 Planner 只代表查看会话，是否参与由 Planner 结合上下文决定。模板要求先确认对话对象和新增交流价值，区分已回答的同义评论、新的直接追问、待补全请求与无需参与的闲聊。等待预算只限制继续等待，不禁止回答已完整的问题。

案例来自 2026-09-21 kaguya 服务器的 journal 和持久化 `core.model.task.requested.prompt.variables`。20:50:18 的规划输入中已经包含 20:50:14 成功投递的回复，但随后仍生成近义评论。该记录支持检查语义重复，不能单凭日志判断所有主动发言都不合理。

三个日志案例保留冻结历史与输入顺序，将说话人和引用 ID 匿名化，去除链接、分享密码、记忆和人物投影；另有十七个合成边界案例（含兴趣归属、同名发言者、已核验引用、多话题选择、情绪回应及已解决请求）。匿名化引用正文只保留引用标记，不保留原始 ID。它们是人工制定目标的诊断集，不是完整生产重放，也不是随机抽取的独立测试集。`log-title` 和 `log-share` 的静默标签表达本次减少无内容插话的目标，并非唯一合理答案。

评测将冻结变量交给生产模板渲染器，并附加生产 JSON 输出协议。默认使用版本 2 的本轮动作 schema；`KAGUYA_EVAL_TASK_VERSION=1` 选择旧通用契约，方便同案例对照。模型输出必须通过本轮 schema、焦点索引上界与等待预算检查，再与预期动作及可选的 `expectedFocus` 比较。没有模型裁判，也不自动修复非法 JSON。模型使用 OpenAI-compatible JSON object 请求，固定 temperature=0、单次超时 120 秒，不执行生产端的结构化失败恢复。生产端生成参数与服务调度不同，因此这里的通过率不能直接等同线上成功率。

运行时版本 2 在结构修复阶段就拒绝超预算 wait 与越界焦点；旧任务仍保留 `silent / wait-budget-exhausted` 兜底。本评测不执行结构修复，原始非法输出直接记为失败，避免恢复机制掩盖模型未遵循契约。

历史对照结果保留在 Git 中：[2026-09-24 Planner 评测](https://github.com/posanbu/Kaguya/blob/a0a565a21279f4fac72e1fd381323c101e50af65/promptfoo/RESULTS-211-PLANNER.md)和[早期 #212 评测](https://github.com/posanbu/Kaguya/blob/a0a565a21279f4fac72e1fd381323c101e50af65/promptfoo/RESULTS-211.md)。后者的 22/24 仅属于当时的 Planner 提示词实验。后续 #222 已移除 Arousal 的语义评分；当前实现进一步补充数据库角色设定、多人背景、引用正文及本轮动作约束。这里仍只评测冻结输入到模型输出，检索正确性、持久化和重放由独立测试覆盖，不把本评测当成线上整体效果。

## 运行方式

先安装依赖并完成 `pnpm exec tsc -b`。运行联网评测必须显式指定评测 profile；profile 内含服务商配置，不能提交进仓库。建议在独立工作目录使用仅用于评测的 profile。服务端执行可读取已经授权的现有 profile，密钥无需复制到本地。

```sh
KAGUYA_EVAL_PROFILE=/absolute/path/to/profile.json \
PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 \
pnpm exec promptfoo eval -c promptfoo/planner-behavior.yaml \
  --no-cache --repeat 2 --output /tmp/planner-candidate.json
```

默认读取仓库的 `heartflow.planner.default.hbs`，刻意不读取 local 覆盖以保证评测版本明确。可用 `KAGUYA_EVAL_TEMPLATE=/absolute/path/to/baseline.hbs` 比较历史模板，或用 `KAGUYA_EVAL_SOURCE_ROOT` 指向已构建源码根目录。两组对照必须使用相同案例、模型、参数和模板变量，保留服务错误及非法响应作为失败分母。

评测完成后按案例比较各次结果，不能只报告平均通过率。原始评测输出、真实日志、profile、local 模板及分享凭据不应提交进仓库。模板在服务器生效需要遵循对应版本的模板加载和配置应用方式；本地 default 的变化不会自动更新已有 local 覆盖。
