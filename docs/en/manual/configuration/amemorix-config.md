---
title: A_Memorix Memory System Configuration
---

# A_Memorix Memory System Configuration

A_Memorix is MaiBot's long-term memory system, responsible for memory storage, vectorization, retrieval, person profiles, memory evolution, and Web operations. It replaces the old `[memory]` configuration section with finer-grained controls.

This document details how to configure the `[a_memorix]` section in `bot_config.toml`.

::: tip Understand the concept first
If you are not yet familiar with the memory system, it is recommended to first read [Memory System Feature Overview](../features/memory-system.md) to understand what it can do.
:::

## Configuration Structure Overview

A_Memorix configuration is located under the `[a_memorix]` section of `bot_config.toml`, containing 12 subsections. TOML section names are case-sensitive, please use lowercase `a_memorix`:

```toml
[a_memorix]

[a_memorix.integration]          # Memory usage in chat
[a_memorix.plugin]               # Memory system master switch
[a_memorix.storage]              # Data storage location
[a_memorix.embedding]            # Memory vectorization
[a_memorix.retrieval]            # Memory retrieval
[a_memorix.threshold]            # Threshold filtering
[a_memorix.filter]               # Chat filtering
[a_memorix.episode]              # Episode generation
[a_memorix.person_profile]       # Person profile
[a_memorix.memory]               # Memory evolution
[a_memorix.advanced]             # Advanced runtime
[a_memorix.web]                  # Web operations
```

::: info
Older documentation or legacy standalone configuration files may use `A_memorix` or `config/a_memorix.toml`. The current MaiBot main configuration uses `[a_memorix]` in `config/bot_config.toml`; the old `config/a_memorix.toml` serves only as a compatibility migration source.
:::

---

## Memory Integration [a_memorix.integration]

Controls how MaiMai uses long-term memory in chat. Includes memory retrieval tools, person profile query/injection, chat summary writeback, and feedback correction.

### Basic Integration

- **`enable_memory_query_tool`** — Whether to allow MaiMai to query long-term memory during chat. Enabled by default
- **`memory_query_default_limit`** — Default number of results to retrieve from long-term memory each time, range `1-20`. Default: 5
- **`enable_person_profile_query_tool`** — Whether to allow MaiMai to query person profile memory. Enabled by default
- **`enable_person_profile_injection`** — Whether to automatically inject relevant person profiles before Maisaka Planner invocation. Enabled by default
- **`person_profile_injection_max_profiles`** — Maximum number of person profiles automatically injected per round, range `1-5`. Default: 3
- **`person_fact_writeback_enabled`** — Whether to automatically extract and write back person facts to long-term memory after sending a reply. Enabled by default
- **`chat_summary_writeback_enabled`** — Whether to automatically write back chat summaries to long-term memory by message window during Maisaka chat. Enabled by default
- **`chat_summary_writeback_message_threshold`** — Message window threshold for automatic chat summary writeback (advanced). Default: 36
- **`chat_summary_writeback_context_length`** — Number of messages to look back from the chat stream when automatically writing back chat summaries, range `1-500` (advanced). Default: 36

### Feedback Correction

Feedback correction is disabled by default and is an advanced feature. It attempts to correct old memories based on user feedback within a time window after `query_memory`.

- **`feedback_correction_enabled`** — Whether to enable feedback-driven delayed memory correction tasks (advanced). Disabled by default
- **`feedback_correction_window_hours`** — Feedback window duration in hours, starting from the `query_memory` execution time (advanced). Default: 12.0
- **`feedback_correction_check_interval_minutes`** — Feedback correction scheduled task polling interval in minutes (advanced). Default: 30
- **`feedback_correction_batch_size`** — Maximum number of tasks processed per feedback correction round, range `1-200` (advanced). Default: 20
- **`feedback_correction_auto_apply_threshold`** — Minimum confidence threshold for automatically applying correction actions, range `0-1` (advanced). Default: 0.85
- **`feedback_correction_max_feedback_messages`** — Maximum number of user feedback messages within the window used per correction task (advanced). Default: 30
- **`feedback_correction_prefilter_enabled`** — Whether to enable pre-filtering for corrections to reduce unnecessary model calls (advanced). Enabled by default
- **`feedback_correction_paragraph_mark_enabled`** — Whether to write corrected old-fact markers on affected paragraphs (advanced). Enabled by default
- **`feedback_correction_paragraph_hard_filter_enabled`** — Whether to hard-filter paragraphs with stale markers in user-side queries (advanced). Enabled by default
- **`feedback_correction_profile_refresh_enabled`** — Whether to add affected person profiles to the refresh queue after feedback correction (advanced). Enabled by default
- **`feedback_correction_profile_force_refresh_on_read`** — Whether to force a refresh instead of reusing old snapshots when reading profiles in the dirty queue (advanced). Enabled by default
- **`feedback_correction_episode_rebuild_enabled`** — Whether to add affected sources to the episode rebuild queue after feedback correction (advanced). Enabled by default
- **`feedback_correction_episode_query_block_enabled`** — Whether to block episode sources in the rebuild queue from user-side queries (advanced). Enabled by default
- **`feedback_correction_reconcile_interval_minutes`** — Polling interval for the feedback correction two-phase consistency background reconciliation task in minutes (advanced). Default: 5
- **`feedback_correction_reconcile_batch_size`** — Batch size for processing profile/episode queues per round in the feedback correction two-phase consistency task (advanced). Default: 20

::: warning Feedback correction is an advanced feature
Feedback correction is disabled by default. Enabling it will incur additional model calls and computational overhead. If you are unsure what it does, it is recommended to keep the default `false`.
:::

---

## Memory System [a_memorix.plugin]

Master switch for the long-term memory system.

- **`enabled`** — Whether to enable the long-term memory system. Disabled by default

::: warning Disabled by default
The memory system is disabled by default and must be manually set to `true` to enable. Before enabling, ensure the embedding model is properly configured.
:::

---

## Storage [a_memorix.storage]

- **`data_dir`** — Data directory where memory data will be stored. Default: `data/a-memorix`

---

## Memory Vectorization [a_memorix.embedding]

Basic settings for converting memory content into vectors. Vectorization is the foundation of memory retrieval; choosing the right model and parameters directly impacts retrieval quality.

### Basic Configuration

- **`model_name`** — Model used to convert memory content into vectors; `auto` means automatic selection. Default: `auto`
- **`dimension`** — Dimension of memory vectors, must be consistent with the vectorization model. Default: 1024
- **`dimension_request_mode`** — Controls whether the embedding request carries a dimension parameter: `explicit` only when requested, `always` on every request, and `never` to omit it. Default: `explicit`
- **`batch_size`** — Number of memory items processed per vectorization request. Default: 32
- **`max_concurrent`** — Number of concurrent vectorization requests. Default: 5
- **`enable_cache`** — Whether to cache vectorization results. Disabled by default
- **`runtime_train_threshold`** — Minimum number of untrained vectors required to trigger background SQ8 training at runtime. Default: 256
- **`quantization_type`** — Vector compression method, currently only supports `int8` (SQ8). Default: `int8`

### Embedding Fallback [a_memorix.embedding.fallback]

Degradation strategy when the primary embedding service is unavailable.

- **`enabled`** — Whether to enable the fallback mechanism. Enabled by default
- **`probe_interval_seconds`** — Probe interval in seconds, periodically checks if the primary service has recovered. Default: 180
- **`allow_metadata_only_write`** — Whether to allow writing metadata only (skip vectorization during fallback). Enabled by default

### Paragraph Vector Backfill [a_memorix.embedding.paragraph_vector_backfill]

Handles paragraphs missing vectors and asynchronously completes vector data.

- **`enabled`** — Whether to enable the backfill task. Enabled by default
- **`interval_seconds`** — Backfill polling interval in seconds. Default: 60
- **`batch_size`** — Number of items per backfill batch. Default: 64
- **`max_retry`** — Maximum number of retries. Default: 5

---

## Retrieval [a_memorix.retrieval]

Controls memory retrieval behavior, including Top-K parameters, PPR graph computation, and sparse retrieval.

### Basic Retrieval Configuration

- **`top_k_paragraphs`** — Paragraph candidate count. Default: 20
- **`top_k_relations`** — Relation candidate count. Default: 10
- **`top_k_final`** — Final number of results returned. Default: 10
- **`alpha`** — Relation fusion weight, range `0.0-1.0`. Default: 0.5
- **`enable_ppr`** — Whether to enable PPR (Personalized PageRank) graph computation. Enabled by default
- **`ppr_alpha`** — PPR alpha parameter, range `0.0-1.0`. Default: 0.85
- **`ppr_timeout_seconds`** — PPR timeout in seconds. Default: 1.5
- **`ppr_concurrency_limit`** — PPR concurrency limit. Default: 4
- **`enable_parallel`** — Whether to enable parallel retrieval. Enabled by default

### Sparse Retrieval [a_memorix.retrieval.sparse]

Configuration for sparse retrieval based on full-text search (FTS5), used to supplement vector retrieval.

- **`enabled`** — Whether to enable sparse retrieval. Enabled by default
- **`backend`** — Sparse retrieval backend. Default: `fts5`
- **`mode`** — Sparse retrieval mode: `auto` for automatic selection, `fallback_only` to fall back only when vector retrieval fails, `hybrid` for hybrid mode. Default: `auto`
- **`tokenizer_mode`** — Tokenizer mode. Options: `jieba`, `mixed`, `char_2gram`. Default: `jieba`
- **`candidate_k`** — Paragraph candidate count. Default: 80
- **`relation_candidate_k`** — Relation candidate count. Default: 60

---

## Threshold Filtering [a_memorix.threshold]

Controls the threshold filtering strategy for retrieval results, used to filter high-quality memory entries.

- **`min_threshold`** — Minimum threshold; results below this value will be filtered out. It must be lower than `max_threshold`. Default: 0.29
- **`max_threshold`** — Maximum threshold, range `0.0-1.0`. Default: 0.95
- **`percentile`** — Dynamic threshold percentile, range `0-100`. Default: 75
- **`min_results`** — Minimum number of results to retain; ensures at least this many results remain even if threshold filtering reduces them. Default: 4

---

## Chat Filtering [a_memorix.filter]

Controls which chat streams participate in memory read/write operations.

- **`enabled`** — Whether to enable chat filtering. Enabled by default
- **`mode`** — Filter mode: blacklist mode excludes listed chat streams, whitelist mode only includes listed chat streams. Options: `blacklist`, `whitelist`. Default: `blacklist`
- **`chats`** — Chat stream list. Default: empty

---

## Episode [a_memorix.episode]

An Episode is an automatic summary and segmentation of a conversation, and is one of the core data units of the memory system.

- **`enabled`** — Whether to enable Episodes. Enabled by default
- **`generation_enabled`** — Whether to enable automatic generation. Enabled by default
- **`source_poll_interval_seconds`** — Polling interval for source-level Episode jobs, in seconds. Default: 1.0
- **`source_batch_size`** — Number of source jobs claimed in one cycle. Default: 20
- **`source_max_retry`** — Maximum attempts for each source version, including the first attempt. Default: 3
- **`source_lease_seconds`** — Source-job lease duration in seconds. Default: 1800
- **`source_max_wait_seconds`** — Maximum debounce wait while a source continues receiving writes, in seconds. Default: 60
- **`max_paragraphs_per_call`** — Maximum number of paragraphs per call. Default: 20
- **`max_chars_per_call`** — Maximum number of characters per call, range `100+`. Default: 6000
- **`source_time_window_hours`** — Source time window in hours. Default: 24.0
- **`segmentation_model`** — Segmentation model selection; `auto` means automatic selection. Default: `auto`

---

## Person Profile [a_memorix.person_profile]

Person profiles maintain a summary archive for each user, containing key facts and preferences, automatically injected into context during chat.

- **`enabled`** — Whether to enable profiles. Enabled by default
- **`refresh_interval_minutes`** — Refresh interval in minutes. Default: 30
- **`active_window_hours`** — Active window in hours, range `1.0+`. Default: 72.0
- **`max_refresh_per_cycle`** — Maximum number of refreshes per cycle. Default: 50
- **`top_k_evidence`** — Number of evidence items. Default: 12

---

## Memory Evolution [a_memorix.memory]

Memory evolution controls the decay mechanism of memories, allowing old memories to naturally weaken over time and preventing outdated information from interfering.

- **`enabled`** — Whether to enable memory evolution. Enabled by default
- **`half_life_hours`** — Half-life in hours; memory weight halves after each such period. Default: 24.0
- **`prune_threshold`** — Prune threshold; memories with weight below this value will be marked for pruning, range `0.0-1.0`. Default: 0.1
- **`freeze_duration_hours`** — Freeze duration in hours; newly written memories do not participate in evolution during the freeze period. Default: 24.0
- **`revive_threshold`** — Retention-strength threshold for reviving a frozen relation; must be greater than `prune_threshold`. Default: 0.15
- **`access_reinforcement_alpha`** — Saturating reinforcement factor applied when a memory is selected for use. Default: 0.05
- **`access_reinforcement_cooldown_minutes`** — Minimum interval between access reinforcements for the same relation; `0` disables the limit. Default: 60
- **`explicit_reinforcement_alpha`** — Saturating reinforcement factor for explicit reinforcement or independent new evidence. Default: 0.5
- **`weaken_alpha`** — Proportional factor for explicit weakening events. Default: 0.5
- **`lifecycle_batch_size`** — Number of expired relations processed in one lifecycle cycle. Default: 1000

---

## Advanced Runtime [a_memorix.advanced]

- **`enable_auto_save`** — Whether to enable automatic saving. Enabled by default
- **`auto_save_interval_minutes`** — Auto-save interval in minutes. Default: 5
- **`debug`** — Whether to enable debug mode. Disabled by default

---

## Web Operations [a_memorix.web]

Manages memory system operations through the WebUI, including two sub-modules: the Import Center and the Tuning Center.

### Import Center [a_memorix.web.import]

- **`enabled`** — Whether to enable the Import Center. Enabled by default
- **`max_queue_size`** — Maximum queue length. Default: 20
- **`max_files_per_task`** — Maximum number of files per task. Default: 200
- **`max_file_size_mb`** — Maximum file size in MB. Default: 20
- **`max_paste_chars`** — Maximum paste character count. Default: 200000
- **`default_file_concurrency`** — Default file concurrency. Default: 2
- **`default_chunk_concurrency`** — Default chunk concurrency. Default: 4

### Tuning Center [a_memorix.web.tuning]

- **`enabled`** — Whether to enable the Tuning Center. Enabled by default
- **`max_queue_size`** — Maximum queue length. Default: 8
- **`poll_interval_ms`** — Polling interval in milliseconds. Default: 1200
- **`default_intensity`** — Default tuning intensity, options: `quick`, `standard`, `deep`. Default: `standard`
- **`default_objective`** — Default tuning objective, options: `precision_priority`, `balanced`, `recall_priority`. Default: `precision_priority`
- **`default_top_k_eval`** — Default evaluation Top-K. Default: 20
- **`default_sample_size`** — Default sample size. Default: 24

---

## Migrating from Legacy [memory]

A_Memorix replaces the old `[memory]` configuration section. If you previously used `[memory]`, follow the migration mapping below:

### Field Mapping

- **`global_memory`** → **`filter.mode`** — Global memory functionality is now controlled by the filter mode. Old `global_memory = true` corresponds to new `filter.mode = "blacklist"` with an empty `filter.chats`; old `global_memory = false` corresponds to whitelist mode or blacklist with all chat streams added
- **`global_memory_blacklist`** → **`filter.chats`** — Blacklist migrated to `filter.chats`, used with `filter.mode = "blacklist"`
- **`enable_memory_query_tool`** → **`integration.enable_memory_query_tool`** — Direct migration
- **`memory_query_default_limit`** → **`integration.memory_query_default_limit`** — Direct migration
- **`person_fact_writeback_enabled`** → **`integration.person_fact_writeback_enabled`** — Direct migration
- **`chat_summary_writeback_enabled`** → **`integration.chat_summary_writeback_enabled`** — Direct migration
- **`chat_summary_writeback_message_threshold`** → **`integration.chat_summary_writeback_message_threshold`** — Direct migration, note default changed from `12` to `36`
- **`chat_summary_writeback_context_length`** → **`integration.chat_summary_writeback_context_length`** — Direct migration, note default changed from `50` to `36`
- **`feedback_correction_*`** → **`integration.feedback_correction_*`** — All feedback correction configuration moved into the `integration` subsection

### Default Value Changes

- **`chat_summary_writeback_message_threshold`** — Old default `12`, new default `36`. Message window threshold increased, reducing summary writeback frequency
- **`chat_summary_writeback_context_length`** — Old default `50`, new default `36`. Lookback message count adjusted

### Migration Example

Old configuration:

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

After migration:

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

## Configuration Examples

### Minimal Configuration

The simplest configuration, only enables the memory system and uses all defaults:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[a_memorix]

[a_memorix.plugin]
enabled = true
```

:::

All other subsections will use default values. This approach is suitable for quick start, but ensure the embedding model can be auto-selected.

### Recommended Daily Configuration

A recommended configuration suitable for daily use, with minor adjustments from defaults:

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

### Advanced Configuration

Enabling feedback correction, adjusting retrieval parameters, and memory evolution strategies:

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

## Frequently Asked Questions

### Q: Nothing is retrieved after enabling the memory system?

1. Make sure `enabled` under `[a_memorix.plugin]` is set to `true`
2. Confirm the embedding model is correctly configured; `model_name = "auto"` will auto-select an available model
3. Memory needs to accumulate a certain amount of data before retrieval quality improves; there may be no results right after enabling
4. Check if `min_threshold` under `[a_memorix.threshold]` is too high

### Q: How do I troubleshoot vectorization failures?

1. Check if the embedding model is available
2. Check if `[a_memorix.embedding.fallback]` is enabled; the fallback mechanism keeps basic operation when the primary service is unavailable
3. If memories cannot be vectorized during fallback, check if `allow_metadata_only_write` is `true` (allows writing metadata only)

### Q: Should I enable feedback correction?

Feedback correction is disabled by default and is an experimental advanced feature. It can automatically correct old memories based on users' subsequent conversations, but it increases model call overhead. It is recommended to consider enabling it when the memory data volume is large and there is noticeable outdated information.

### Q: How do person profiles work?

Person profiles maintain a summary of key facts for each chat contact. When `enable_person_profile_injection = true`, the Planner will automatically inject relevant person profiles before generating replies, allowing MaiMai to "remember" the other person. `refresh_interval_minutes` controls the profile refresh frequency.

### Q: Does memory evolution affect existing memories?

Memory evolution is gradual. `half_life_hours` controls the decay speed, `freeze_duration_hours` ensures newly written memories are not modified by evolution for a period of time, and `prune_threshold` sets the pruning floor. Memories with weight below the prune threshold are marked but not immediately deleted.

### Q: How do I choose a sparse retrieval mode?

- `auto`: Automatically decides whether to enable sparse retrieval supplementation based on vector retrieval results, recommended for most cases
- `fallback_only`: Only used when vector retrieval fails, suitable for scenarios with stable vectorization service
- `hybrid`: Always uses both vector and sparse retrieval in hybrid mode, highest retrieval recall but higher computational overhead

---

## Next Steps

- Learn about memory system concepts and architecture -> [Memory System Feature Overview](../features/memory-system.md)
- View an overview of all configuration options -> [Bot Configuration Overview](./bot-config.md)
