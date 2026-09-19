# Kaguya fast-policy benchmark

本目录提供 [issue #181](https://github.com/posanbu/Kaguya/issues/181) 的独立短策略基准工具：比较 Flash / Pro、thinking off / low 和 compact / medium / long 三档上下文，共 12 个条件。它不会修改生产 Planner、启动机器人或发送平台消息。

**正式实验由使用者运行。本次只交付代码，不提供模型优劣结论。** 工具硬性限制单个运行进程最多 20 个同时在途请求；不要同时启动多个 runner 或同时运行 preflight，以免合计超过并发上限。

## 测量范围

探针要求模型输出短 JSON：

```json
{ "action": "message", "intent": "answer", "provide": ["I0"], "avoid": [] }
```

`action` 为 `message | wait | silent`；`intent` 为 `answer | clarify | support | acknowledge | boundary | coordinate | defer | none`。`provide` 和 `avoid` 只能引用当前 context 的 `information` ID，ID 不可重复，两组不能相交。

这是为了精确评分而定义的 `kaguya-fast-policy-probe/v1`。生产 Planner 的 `composition.topic/replyAct/guidance/focusInputIndexes` 为另一套协议；本工具的得分不能直接宣称为生产 Planner 的端到端效果。

模型名默认 `deepseek-flash` 和 `deepseek-v4-pro`，端点默认 `https://api.llm.ustc.edu.cn/v1`。DeepSeek 官方将 `deepseek-flash` 定义为 V4.1 Flash，并使用 `thinking.type` 与 `reasoning_effort` 控制推理；第三方网关是否保持该映射和参数语义，仍须根据响应、网关配置及 preflight 核查。[官方模型说明](https://api-docs.deepseek.com/)、[thinking 参数](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 协作者获取代码与准备数据

Python 3.10+ 即可运行测量和汇总，使用标准库，无需安装 Python 包。读取生产账本还需 Kaguya 已安装的 Node.js / `packages/database` 的 `pg` 依赖。建议在 kaguya 服务器上单独克隆实验分支，沿用部署目录的数据库连接与依赖：

```bash
git clone --branch codex/issue-181-benchmark \
  https://github.com/posanbu/Kaguya.git Kaguya-benchmark-181
cd Kaguya-benchmark-181

# 改成服务器上已经安装依赖的 Kaguya 部署目录。
KAGUYA_SOURCE_ROOT=/path/to/deployed/Kaguya
node benchmarks/fast-policy/export_workload.mjs \
  --repo-root "$KAGUYA_SOURCE_ROOT" \
  --config-root "$KAGUYA_SOURCE_ROOT/.data/kaguya-config" \
  --output .data/fast-policy/source/source-private.jsonl

python3 benchmarks/fast-policy/prepare_dataset.py \
  --source .data/fast-policy/source/source-private.jsonl \
  --output .data/fast-policy/dataset
```

如果部署使用仓库外的配置目录，将 `--config-root` 换成实际配置根。执行者需要有读取配置和数据库的权限；真实配置、API key、原始导出与模型响应均不随 PR 分发。单独克隆使实验工具与部署目录分离，无需切换正在运行服务的分支或重载服务。

exporter 使用 PostgreSQL `REPEATABLE READ READ ONLY` 事务，仅选择 `core.model.task.requested` 中 `taskId=agent.turn.plan` 的请求及其显式引用的上下文，包含历史成功、取消和失败请求，不按旧结果筛选。不会把后验模型回答当标签，也不会补入请求之后才出现的上下文。

`prepare_dataset.py` 保留每条请求的冻结时间、身份、当前 turn 和会话关系，固定以下嵌套规则：

- compact：最近 2 条历史，无可选记忆。
- medium：最近 8 条历史，首次冻结顺序中的前 4 条记忆。
- long：全部已经冻结的历史和记忆。

三档的当前输入和候选信息 ID 完全一致，候选信息来自当前输入。增加历史只帮助选择当前输入，不扩大信息候选集合。因此这里的信息选择只衡量当前输入 ID 的取舍，不能代表对长期记忆秘密的完整泄露审计。三档是实际可用数据的子集，不承诺固定 token 长度，也不重复文本补足预算。manifest 会统计三档实际增量和完全相同的案例数。

只读检查时服务器有 53 条冻结 Planner 请求，少于 issue 建议的 100–300 条；再次导出时应以新 manifest 的实际数量为准。不能把重复调用、context 变体或示例数据算成新的真实 workload。

## 标注与离线核查

生成的 `cases.jsonl` 每行包含 `id`、`provenance`、`contexts` 和 `gold`。默认 `gold: null`；此时只测协议有效性、完成率、延迟和 token，所有正确率为 `null`。

需要质量比较时，应在看模型结果前独立标注并冻结如下对象；`required_information` 和 `forbidden_information` 必须引用三档都可见的 ID：

```json
{
  "action": "message",
  "intent": "answer",
  "required_information": ["I0"],
  "forbidden_information": ["I1"]
}
```

当前评分把这两个集合视为穷尽的封闭标签：required 以外的提供内容会计入多余信息，因此不能把一个随手列出的、不完整的参考答案当作标签。存在多个合理动作或信息组合时，先固定标注规则并复核，或保留 `gold: null`。模型辅助标注应另存标注来源与分歧，不冒充人工 gold。Prompt 只序列化 `contexts[档位]`，不会发送 `gold` 或历史模型结果。

先运行纯离线测试与完整请求预览。这些命令不读取 API key，也不调用模型：

```bash
python3 -m unittest discover -s benchmarks/fast-policy -p 'test_*.py' -v
node --test benchmarks/fast-policy/export_workload.test.mjs
python3 benchmarks/fast-policy/runner.py \
  --dataset .data/fast-policy/dataset/cases.jsonl \
  --output .data/fast-policy/dry-run \
  --dry-run
```

`example.jsonl` 只有 3 条虚构的用法示例，可替代上述 dataset 做代码检查，不用于报告真实效果。`--dry-run` 写出完整 `requests.jsonl` 和 manifest，方便确认每条输入的 12 个条件及无答案泄漏。所有输出目录必须新建，已有结果会拒绝覆盖。

## 权限检查与正式运行

**以下命令会调用模型 API，应由实验执行者运行。** `--ask-api-key` 使用隐藏终端输入，不把 key 写进源码、命令历史或 manifest；也支持环境变量 `API_KEY` 或 `--api-key-file`。

先做至多 4 次、串行执行的虚构请求，检查两模型的 off / low：

```bash
python3 benchmarks/fast-policy/preflight.py \
  --output .data/fast-policy/preflight \
  --ask-api-key
```

若 `deepseek-v4-pro` 返回 HTTP 403（如 `Model is blocked` 或 `key_model_access_denied`），需先开通网关授权或配置一个明确可用的模型端点；工具不会把 Pro 自动换成 Flash。只跑 Flash 时，preflight 和 runner 都加 `--models flash`；更换端点或别名使用 `--base-url`、`--flash-model`、`--pro-model`，并在同一组实验中保持配置一致。

确认权限、标注和数据后运行完整矩阵：

```bash
python3 benchmarks/fast-policy/runner.py \
  --dataset .data/fast-policy/dataset/cases.jsonl \
  --output .data/fast-policy/run-01 \
  --concurrency 20 \
  --repeats 1 \
  --timeout 60 \
  --ask-api-key
```

53 个样本对应完整矩阵 636 次请求，只跑 Flash 为 318 次。`--limit 3` 可先做小规模检查；重复实验应使用新目录并保存相同数据和配置，不能把重复次数计作独立样本量。

请求使用 `temperature=0`、`response_format=json_object`、`max_tokens=2048`。2048 是包含 reasoning 的总生成上限，不是期望的最终回答长度；截断会按失败记录。off 显式发送 `thinking.type=disabled`，low 发送 `thinking.type=enabled` 与 `reasoning_effort=low`。随机种子默认 181，按 sample × repeat 随机区组，再随机打散各模型、模式与上下文条件。没有隐藏重试，失败不会被后一次成功替换。

## 输出和指标解释

`manifest.json` 固定数据、提示词、runner 和调度哈希、样本数、模型、参数、随机种子、计划/实际请求数及起止时间。`samples.jsonl` 保存逐次请求、SSE 原始事件、回答、推理文本、HTTP 错误、实际返回模型名、usage 和计时；它包含私人会话，应保留在 `.data/` 或其它私有目录，不能提交。输出目录权限为 0700，文件为 0600。

`summary.json` 按 `模型 / thinking / context` 汇总，并分别给出 2 秒和 10 秒预算统计。有效完成要求最终 JSON 严格符合协议、`finish_reason=stop` 且 SSE 收到 `[DONE]`；不完整流、格式错误、拒绝访问、超时或截断都不算完成。预算以完整流的 `total_latency_s` 为准，分母包括全部实际尝试。判断 JSON 首次完整的 `decision_latency_s` 单列，不能用尚未结束或最终变得无效的 JSON 提前宣称成功。

有标签时，`quality` 以全部有标签尝试为分母，给出 action 三分类、reply/no-reply 二分类、intent、信息集合完全一致和联合正确率；无效、超时及超预算输出计零。`completed_only_quality` 单列有效完成后的正确率，避免把质量和可用性混为一谈。provide 的 precision/recall/F1 按样本取宏平均，预测和要求均为空时为 1，任一非空而交集为空时为 0。没有标签时这些指标保持 `null`。

`forbidden_information_message_rate` 是有效、预算内且有标签的 message 输出中，提供至少一条 forbidden 信息的比例；`unnecessary_information_rate` 是这些输出中非 required 信息项数占全部提供项数的比例。两者的适用输出数和信息项分母随结果保存，分母为零时为 `null`。这两个风险率不能脱离完成率单独比较，失败很多的模型可能没有足够有效输出供统计。

`ttft_s` 是发起请求到首个非空 reasoning 或 content delta；`first_reasoning_s` 和 `first_content_s` 分别记录首个推理和最终回答 delta。off 中出现推理会计入异常观察，low 没观察到推理只说明缺乏信号，不证明网关关闭了推理。客户端线程排队不计入这两个时间，本工具测量的是指定并发压力下从请求发起到响应的延迟。它不是 Kaguya 生产系统从消息入站到最终投递的总延迟。缓存命中、服务端排队和网关变化均可能影响结果，应结合实际 usage、重复实验与随机区组解释。

usage 只采用服务端报告的数据，缺失的 reasoning/cache token 保留 `null`，不按零处理、不从字符数估算。`observed` 表示有该计数的请求数。有效完成不等于决策正确；没有独立标签时不能回答“Flash 是否足够可靠”或“Pro 是否更好”。

按 Ctrl-C 中断时会取消尚未发出的请求，在途请求最多等待当前 timeout，manifest 标为 `interrupted`；进程被强杀时可能仍为 `running`。已经收到的完整记录保存在 `samples.jsonl`；这些都不能当作完整实验。请用新目录重跑完整区组，避免手工拼接不同配置的结果。

## 交回实验结果

交接时提供 `summary.json`、运行参数、实际返回的模型名、数据与脚本哈希，以及 manifest 中的计划/实际请求数和完成状态。说明使用的独立真实样本数、标注来源、重复次数和模型授权情况；没有 gold 的运行只用于延迟与协议完成率比较。

原始 `samples.jsonl`、导出的数据集和未脱敏 manifest 留在受控存储。需要分享 manifest 时，先移除本地路径与来源标识。发生中断或失败时一并报告，不能只汇总成功请求。这个 PR 只交付实验工具；模型质量、2 秒/10 秒内的可靠性及模型选择结论由正式实验结果决定。
