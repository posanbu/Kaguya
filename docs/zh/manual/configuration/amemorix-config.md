---
title: A_Memorix 记忆系统配置
---

# A_Memorix 记忆系统配置

A_Memorix 是 MaiBot 的长期记忆系统，负责记忆的存储、向量化、检索、人物画像、记忆演化和 Web 运维。它替代了旧版 `[memory]` 配置段落，提供了更细粒度的控制。

本文详细介绍如何在 `bot_config.toml` 中配置 `[a_memorix]` 段落。

::: tip 先了解概念
如果你还不熟悉记忆系统是什么，建议先阅读 [记忆系统功能介绍](../features/memory-system.md)，了解它能做什么。
:::

## 配置结构总览

A_Memorix 配置位于 `bot_config.toml` 的 `[a_memorix]` 段落下，包含 12 个子段落。TOML 段名区分大小写，请使用小写 `a_memorix`：

```toml
[a_memorix]

[a_memorix.integration]          # 记忆在聊天中的使用
[a_memorix.plugin]               # 记忆系统总开关
[a_memorix.storage]              # 数据存储位置
[a_memorix.embedding]            # 记忆向量化
[a_memorix.retrieval]            # 记忆检索
[a_memorix.threshold]            # 阈值过滤
[a_memorix.filter]               # 聊天过滤
[a_memorix.episode]              # Episode 生成
[a_memorix.person_profile]       # 人物画像
[a_memorix.memory]               # 记忆演化
[a_memorix.advanced]             # 高级运行时
[a_memorix.web]                  # Web 运维
```

::: info
旧资料或旧版独立配置文件中可能出现 `A_memorix` 或 `config/a_memorix.toml`。当前 MaiBot 主配置以 `config/bot_config.toml` 中的 `[a_memorix]` 为准；旧版 `config/a_memorix.toml` 仅作为兼容迁移来源。
:::

---

## 记忆集成 [a_memorix.integration]

控制麦麦在聊天中如何使用长期记忆。包括记忆检索工具、人物画像查询/注入、聊天摘要写回和反馈纠错。

### 基础集成

- **`enable_memory_query_tool`** — 是否允许麦麦在聊天时查询长期记忆。默认开启
- **`memory_query_default_limit`** — 每次默认从长期记忆中取回多少条结果，范围 `1-20`。默认 5
- **`enable_person_profile_query_tool`** — 是否允许麦麦查询人物画像记忆。默认开启
- **`enable_person_profile_injection`** — 是否在 Maisaka Planner 调用前自动注入当前对象相关的人物画像。默认开启
- **`person_profile_injection_max_profiles`** — 每轮自动注入的人物画像数量上限，范围 `1-5`。默认 3
- **`person_fact_writeback_enabled`** — 是否在发送回复后自动提取并写回人物事实到长期记忆。默认开启
- **`chat_summary_writeback_enabled`** — 是否在 Maisaka 聊天过程中按消息窗口自动写回聊天摘要到长期记忆。默认开启
- **`chat_summary_writeback_message_threshold`** — 自动写回聊天摘要的消息窗口阈值（高级）。默认 36
- **`chat_summary_writeback_context_length`** — 自动写回聊天摘要时，从聊天流中回看的消息条数，范围 `1-500`（高级）。默认 36

### 反馈纠错

反馈纠错默认关闭，属于高级功能。它会基于 `query_memory` 后一段时间内的用户反馈，尝试纠正旧记忆。

- **`feedback_correction_enabled`** — 是否启用反馈驱动的延迟记忆纠错任务（高级）。默认关闭
- **`feedback_correction_window_hours`** — 反馈窗口时长（小时），以 `query_memory` 执行时间为起点（高级）。默认 12.0
- **`feedback_correction_check_interval_minutes`** — 反馈纠错定时任务轮询间隔（分钟）（高级）。默认 30
- **`feedback_correction_batch_size`** — 反馈纠错每轮最大处理任务数，范围 `1-200`（高级）。默认 20
- **`feedback_correction_auto_apply_threshold`** — 自动应用纠错动作的最低置信度阈值，范围 `0-1`（高级）。默认 0.85
- **`feedback_correction_max_feedback_messages`** — 每个纠错任务最多使用的窗口内用户反馈消息数（高级）。默认 30
- **`feedback_correction_prefilter_enabled`** — 是否启用纠错前置预筛，用于减少不必要的模型调用（高级）。默认开启
- **`feedback_correction_paragraph_mark_enabled`** — 是否为受影响 paragraph 写入已纠正旧事实标记（高级）。默认开启
- **`feedback_correction_paragraph_hard_filter_enabled`** — 是否在用户侧查询中硬过滤带有 stale 标记的 paragraph（高级）。默认开启
- **`feedback_correction_profile_refresh_enabled`** — 是否在反馈纠错后将受影响人物画像加入刷新队列（高级）。默认开启
- **`feedback_correction_profile_force_refresh_on_read`** — 人物画像处于脏队列时，读取是否强制刷新而不直接复用旧快照（高级）。默认开启
- **`feedback_correction_episode_rebuild_enabled`** — 是否在反馈纠错后将受影响 source 加入 episode 重建队列（高级）。默认开启
- **`feedback_correction_episode_query_block_enabled`** — episode source 处于重建队列时，是否对用户侧查询做屏蔽（高级）。默认开启
- **`feedback_correction_reconcile_interval_minutes`** — 反馈纠错二阶段一致性后台协调任务轮询间隔（分钟）（高级）。默认 5
- **`feedback_correction_reconcile_batch_size`** — 反馈纠错二阶段一致性每轮处理 profile/episode 队列的批大小（高级）。默认 20

::: warning 反馈纠错是高级功能
反馈纠错默认关闭。启用后会产生额外的模型调用和计算开销。如果你不清楚它的作用，建议保持默认的 `false`。
:::

---

## 记忆系统 [a_memorix.plugin]

长期记忆系统的总开关。

- **`enabled`** — 是否启用长期记忆系统。默认关闭

::: warning 默认关闭
记忆系统默认关闭，需要手动设为 `true` 才能启用。启用前请确保已正确配置 embedding 模型。
:::

---

## 存储 [a_memorix.storage]

- **`data_dir`** — 数据目录，记忆数据将存储在此目录下。默认 `data/a-memorix`

---

## 记忆向量化 [a_memorix.embedding]

把记忆内容转换为向量时使用的基础设置。向量化是记忆检索的基础，选择合适的模型和参数直接影响检索质量。

### 基础配置

- **`model_name`** — 用于把记忆内容转换成向量的模型，`auto` 表示自动选择。默认 `auto`
- **`dimension`** — 记忆向量的维度，需要与向量化模型保持一致。默认 1024
- **`dimension_request_mode`** — 是否在 embedding 请求中携带维度参数：`explicit` 仅在显式指定时携带，`always` 总是携带，`never` 从不携带。默认 `explicit`
- **`batch_size`** — 每次向量化请求处理的记忆条数。默认 32
- **`max_concurrent`** — 同时进行的向量化请求数量。默认 5
- **`enable_cache`** — 是否缓存向量化结果。默认关闭
- **`runtime_train_threshold`** — 未训练向量池在运行期间触发 SQ8 后台训练所需的最少向量数。默认 256
- **`quantization_type`** — 向量压缩方式，当前仅支持 `int8`（SQ8）。默认 `int8`

### Embedding 回退 [a_memorix.embedding.fallback]

当主力 embedding 服务不可用时的降级策略。

- **`enabled`** — 是否启用回退机制。默认开启
- **`probe_interval_seconds`** — 探测间隔秒数，定期检测主力服务是否恢复。默认 180
- **`allow_metadata_only_write`** — 是否允许仅写入元数据（回退期间跳过向量化）。默认开启

### 段落向量回填 [a_memorix.embedding.paragraph_vector_backfill]

处理缺少向量的段落，异步补全向量数据。

- **`enabled`** — 是否启用回填任务。默认开启
- **`interval_seconds`** — 回填轮询间隔（秒）。默认 60
- **`batch_size`** — 单批回填数量。默认 64
- **`max_retry`** — 最大重试次数。默认 5

---

## 检索 [a_memorix.retrieval]

控制记忆检索的行为，包括 Top-K 参数、PPR 图计算和稀疏检索。

### 基础检索配置

- **`top_k_paragraphs`** — 段落候选数。默认 20
- **`top_k_relations`** — 关系候选数。默认 10
- **`top_k_final`** — 最终返回条数。默认 10
- **`alpha`** — 关系融合权重，范围 `0.0-1.0`。默认 0.5
- **`enable_ppr`** — 是否启用 PPR（Personalized PageRank）图计算。默认开启
- **`ppr_alpha`** — PPR alpha 参数，范围 `0.0-1.0`。默认 0.85
- **`ppr_timeout_seconds`** — PPR 超时秒数。默认 1.5
- **`ppr_concurrency_limit`** — PPR 并发限制。默认 4
- **`enable_parallel`** — 是否启用并行检索。默认开启

### 稀疏检索 [a_memorix.retrieval.sparse]

基于全文检索（FTS5）的稀疏检索配置，用于补充向量检索。

- **`enabled`** — 是否启用稀疏检索。默认开启
- **`backend`** — 稀疏检索后端。默认 `fts5`
- **`mode`** — 稀疏检索模式：`auto` 自动选择、`fallback_only` 仅在向量检索失败时回退、`hybrid` 混合模式。默认 `auto`
- **`tokenizer_mode`** — 分词模式。可选 `jieba`、`mixed`、`char_2gram`。默认 `jieba`
- **`candidate_k`** — 段落候选数。默认 80
- **`relation_candidate_k`** — 关系候选数。默认 60

---

## 阈值过滤 [a_memorix.threshold]

控制检索结果的阈值过滤策略，用于筛选出高质量的记忆条目。

- **`min_threshold`** — 最小阈值，低于此值的检索结果将被过滤，范围 `0.0-1.0`，并且必须小于 `max_threshold`。默认 0.29
- **`max_threshold`** — 最大阈值，范围 `0.0-1.0`。默认 0.95
- **`percentile`** — 动态阈值百分位，范围 `0-100`。默认 75
- **`min_results`** — 最小保留条数，即使阈值过滤后结果不足也至少保留此数量。默认 4

---

## 聊天过滤 [a_memorix.filter]

控制哪些聊天流参与记忆系统的读写。

- **`enabled`** — 是否启用聊天过滤。默认开启
- **`mode`** — 过滤模式：黑名单模式排除列表中的聊天流，白名单模式仅包含列表中的聊天流。可选 `blacklist`、`whitelist`。默认 `blacklist`
- **`chats`** — 聊天流列表。默认为空

---

## Episode [a_memorix.episode]

Episode 是对一段对话的自动总结与分段，是记忆系统的核心数据单元之一。

- **`enabled`** — 是否启用 Episode。默认开启
- **`generation_enabled`** — 是否启用自动生成。默认开启
- **`source_poll_interval_seconds`** — 来源级 Episode 任务的轮询间隔，单位秒。默认 1.0
- **`source_batch_size`** — 单轮领取的来源任务数量。默认 20
- **`source_max_retry`** — 每个来源版本的最大尝试次数，包含首次尝试。默认 3
- **`source_lease_seconds`** — 来源任务租约时长，单位秒。默认 1800
- **`source_max_wait_seconds`** — 来源持续写入时允许的最大防抖等待时间，单位秒。默认 60
- **`max_paragraphs_per_call`** — 单次最大段落数。默认 20
- **`max_chars_per_call`** — 单次最大字符数，范围 `100+`。默认 6000
- **`source_time_window_hours`** — 来源时间窗口小时数。默认 24.0
- **`segmentation_model`** — 分段模型选择，`auto` 表示自动选择。默认 `auto`

---

## 人物画像 [a_memorix.person_profile]

人物画像为每个用户维护一份摘要档案，包含关键事实和偏好，在聊天时自动注入上下文。

- **`enabled`** — 是否启用画像。默认开启
- **`refresh_interval_minutes`** — 刷新间隔分钟数。默认 30
- **`active_window_hours`** — 活跃窗口小时数，范围 `1.0+`。默认 72.0
- **`max_refresh_per_cycle`** — 单轮最大刷新数。默认 50
- **`top_k_evidence`** — 证据条数。默认 12

---

## 记忆演化 [a_memorix.memory]

记忆演化控制记忆的衰减机制，使旧记忆随时间自然弱化，避免过时信息干扰。

- **`enabled`** — 是否启用记忆演化。默认开启
- **`half_life_hours`** — 半衰期小时数，记忆权重每经过此时长衰减一半。默认 24.0
- **`prune_threshold`** — 裁剪阈值，权重低于此值的记忆将被标记为待裁剪，范围 `0.0-1.0`。默认 0.1
- **`freeze_duration_hours`** — 冻结时长小时数，新写入的记忆在冻结期内不参与演化。默认 24.0
- **`revive_threshold`** — 冻结关系恢复为活跃状态的保留强度阈值，必须大于 `prune_threshold`。默认 0.15
- **`access_reinforcement_alpha`** — 记忆被最终采用时的饱和加强系数。默认 0.05
- **`access_reinforcement_cooldown_minutes`** — 同一关系两次访问加强之间的最短间隔，`0` 表示不限制。默认 60
- **`explicit_reinforcement_alpha`** — 用户显式加强或独立新证据的饱和加强系数。默认 0.5
- **`weaken_alpha`** — 显式弱化事件的比例系数。默认 0.5
- **`lifecycle_batch_size`** — 单轮处理的到期关系数量。默认 1000

---

## 高级运行时 [a_memorix.advanced]

- **`enable_auto_save`** — 是否启用自动保存。默认开启
- **`auto_save_interval_minutes`** — 自动保存间隔（分钟）。默认 5
- **`debug`** — 是否启用调试模式。默认关闭

---

## Web 运维 [a_memorix.web]

通过 WebUI 管理记忆系统的运维配置，包含导入中心和调优中心两个子模块。

### 导入中心 [a_memorix.web.import]

- **`enabled`** — 是否启用导入中心。默认开启
- **`max_queue_size`** — 最大队列长度。默认 20
- **`max_files_per_task`** — 单任务最大文件数。默认 200
- **`max_file_size_mb`** — 单文件大小上限（MB）。默认 20
- **`max_paste_chars`** — 粘贴字符数上限。默认 200000
- **`default_file_concurrency`** — 默认文件并发数。默认 2
- **`default_chunk_concurrency`** — 默认分块并发数。默认 4

### 调优中心 [A_memorix.web.tuning]

- **`enabled`** — 是否启用调优中心。默认开启
- **`max_queue_size`** — 最大队列长度。默认 8
- **`poll_interval_ms`** — 轮询间隔（毫秒）。默认 1200
- **`default_intensity`** — 默认调优强度，可选 `quick`、`standard`、`deep`。默认 `standard`
- **`default_objective`** — 默认调优目标，可选 `precision_priority`、`balanced`、`recall_priority`。默认 `precision_priority`
- **`default_top_k_eval`** — 默认评估 Top-K。默认 20
- **`default_sample_size`** — 默认样本数。默认 24

---

## 从旧版 [memory] 迁移

A_Memorix 替代了旧版 `[memory]` 配置段落。如果你之前使用过 `[memory]`，需要按照以下对应关系迁移：

### 字段映射

- **`global_memory`** → **`filter.mode`** — 全局记忆功能现由过滤模式控制。旧版 `global_memory = true` 对应新版 `filter.mode = "blacklist"` + 清空 `filter.chats`；旧版 `global_memory = false` 对应白名单模式或黑名单+加入所有聊天流
- **`global_memory_blacklist`** → **`filter.chats`** — 黑名单列表迁移到 `filter.chats`，配合 `filter.mode = "blacklist"`
- **`enable_memory_query_tool`** → **`integration.enable_memory_query_tool`** — 直接迁移
- **`memory_query_default_limit`** → **`integration.memory_query_default_limit`** — 直接迁移
- **`person_fact_writeback_enabled`** → **`integration.person_fact_writeback_enabled`** — 直接迁移
- **`chat_summary_writeback_enabled`** → **`integration.chat_summary_writeback_enabled`** — 直接迁移
- **`chat_summary_writeback_message_threshold`** → **`integration.chat_summary_writeback_message_threshold`** — 直接迁移，注意默认值从 `12` 变为 `36`
- **`chat_summary_writeback_context_length`** → **`integration.chat_summary_writeback_context_length`** — 直接迁移，注意默认值从 `50` 变为 `36`
- **`feedback_correction_*`** → **`integration.feedback_correction_*`** — 反馈纠错配置全部移入 `integration` 子段落

### 默认值变更

- **`chat_summary_writeback_message_threshold`** — 旧默认值 `12`，新默认值 `36`。消息窗口阈值增大，减少摘要写回频率
- **`chat_summary_writeback_context_length`** — 旧默认值 `50`，新默认值 `36`。回看消息数调整

### 迁移示例

旧版配置：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[memory]
global_memory = true
global_memory_blacklist = []
enable_memory_query_tool = true
memory_query_default_limit = 5
person_fact_writeback_enabled = true
chat_summary_writeback_enabled = true
chat_summary_writeback_message_threshold = 12
chat_summary_writeback_context_length = 50
feedback_correction_enabled = false
```

:::

迁移后：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[a_memorix]

[a_memorix.plugin]
enabled = true

[a_memorix.integration]
enable_memory_query_tool = true
memory_query_default_limit = 5
person_fact_writeback_enabled = true
chat_summary_writeback_enabled = true
chat_summary_writeback_message_threshold = 12
chat_summary_writeback_context_length = 50
feedback_correction_enabled = false

[a_memorix.filter]
enabled = true
mode = "blacklist"
chats = []
```

:::

---

## 配置示例

### 最小配置

最简单的配置，仅启用记忆系统并使用全部默认值：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[a_memorix]

[a_memorix.plugin]
enabled = true
```

:::

其余所有子段落将使用默认值。这种方式适合快速上手，但需要确保 embedding 模型能够自动选择。

### 推荐日常配置

适合日常使用的推荐配置，在默认值基础上做少量调整：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[a_memorix]

[a_memorix.plugin]
enabled = true

[a_memorix.integration]
enable_memory_query_tool = true
memory_query_default_limit = 5
enable_person_profile_query_tool = true
enable_person_profile_injection = true
person_profile_injection_max_profiles = 3
person_fact_writeback_enabled = true
chat_summary_writeback_enabled = true

[a_memorix.embedding]
model_name = "auto"
dimension = 1024

[a_memorix.filter]
enabled = true
mode = "blacklist"
chats = []

[a_memorix.threshold]
min_threshold = 0.29
min_results = 4
```

:::

### 高级配置

启用反馈纠错、调整检索参数和记忆演化策略：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[a_memorix]

[a_memorix.plugin]
enabled = true

[a_memorix.integration]
enable_memory_query_tool = true
memory_query_default_limit = 8
enable_person_profile_query_tool = true
enable_person_profile_injection = true
person_fact_writeback_enabled = true
chat_summary_writeback_enabled = true
feedback_correction_enabled = true
feedback_correction_window_hours = 12.0
feedback_correction_auto_apply_threshold = 0.9

[a_memorix.embedding]
model_name = "auto"
dimension = 1024
batch_size = 64
max_concurrent = 8

[a_memorix.embedding.fallback]
enabled = true
probe_interval_seconds = 120

[a_memorix.retrieval]
top_k_paragraphs = 30
top_k_relations = 15
top_k_final = 15
alpha = 0.6
enable_ppr = true
enable_parallel = true

[a_memorix.retrieval.sparse]
enabled = true
mode = "hybrid"
candidate_k = 100

[a_memorix.threshold]
min_threshold = 0.35
max_threshold = 0.95
percentile = 80
min_results = 5

[a_memorix.filter]
enabled = true
mode = "blacklist"
chats = []

[a_memorix.episode]
enabled = true
generation_enabled = true
source_time_window_hours = 48.0

[a_memorix.person_profile]
enabled = true
refresh_interval_minutes = 20
active_window_hours = 96.0

[a_memorix.memory]
enabled = true
half_life_hours = 48.0
prune_threshold = 0.15
freeze_duration_hours = 12.0

[a_memorix.advanced]
enable_auto_save = true
auto_save_interval_minutes = 3
debug = false
```

:::

---

## 常见问题

### Q: 启用记忆系统后检索不到内容？

1. 确认 `[a_memorix.plugin]` 的 `enabled` 设为 `true`
2. 确认 embedding 模型配置正确，`model_name = "auto"` 会自动选择可用模型
3. 记忆需要积累一定数据量后检索效果才会提升，刚启用时可能检索不到内容
4. 检查 `[a_memorix.threshold]` 的 `min_threshold` 是否过高

### Q: 向量化失败怎么排查？

1. 检查 embedding 模型是否可用
2. 查看 `[a_memorix.embedding.fallback]` 是否启用，回退机制能在主力服务不可用时保持基本运行
3. 如果回退期间记忆无法向量化，检查 `allow_metadata_only_write` 是否为 `true`（允许仅写元数据）

### Q: 反馈纠错应该开启吗？

反馈纠错默认关闭，属于实验性高级功能。它能根据用户后续对话自动纠正旧记忆，但会增加模型调用开销。建议在记忆数据量较大且出现明显过时信息时考虑开启。

### Q: 人物画像是怎么工作的？

人物画像会为每个聊天对象维护一份关键事实摘要。`enable_person_profile_injection = true` 时，Planner 在生成回复前会自动注入相关人员画像，让麦麦"记住"对方。`refresh_interval_minutes` 控制画像的刷新频率。

### Q: 记忆演化会影响已有的记忆吗？

记忆演化是渐进式的。`half_life_hours` 控制衰减速度，`freeze_duration_hours` 确保新记忆在写入后一段时间内不会被演化修改，`prune_threshold` 设置了裁剪下限。权重低于裁剪阈值的记忆会被标记但不会立即删除。

### Q: 稀疏检索模式怎么选？

- `auto`：自动根据向量检索结果决定是否启用稀疏检索补充，推荐大多数情况使用
- `fallback_only`：仅在向量检索失败时使用，适合向量化服务稳定的场景
- `hybrid`：始终混合使用向量检索和稀疏检索，检索召回率最高但计算开销更大

---

## 下一步

- 了解记忆系统的概念和架构 -> [记忆系统功能介绍](../features/memory-system.md)
- 查看所有配置项总览 -> [Bot 配置总览](./bot-config.md)
