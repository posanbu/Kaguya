/**
 * 功能概述：为离线升级补充附加表的只读结构检查，阻止 IF NOT EXISTS 掩盖残缺表。
 * 主要职责：inspectOfflineSchema 核对必需列、主键、关键唯一索引及外键；迁移前只接受完整旧表或缺失的后续阶段。
 * 代码库关系：offline-upgrade 在 prepareSchema 前后调用；基础账本的进一步验证仍由数据库包负责。
 * 输入输出与副作用：只执行 SELECT；不修复约束、不重建 epoch、不清空 raw checkpoint/rejection。
 * 媒体字节、来源及冻结输入独立于 Memory 校验：接受旧双表阶段，校验三表列类型、非空、主键、来源唯一键及字节 CHECK。
 * PostgreSQL 会为 position 等标识符加引号；只归一安全小写标识符，仍校验 btree、完整键序、排序、唯一性和表归属。
 * 数据库新增合法增量列需同时加入 incrementalColumns；未知结构以稳定错误码停止。
 */
import type { SqlDatabase } from "@kaguya/database";
type Reader = Pick<SqlDatabase, "query">;
// 每项第一个字符串为必需列，第二个为按顺序排列的主键。
const tables: Record<string, readonly [string, string]> = {
  kaguya_schema_metadata: [
    "singleton version information_protocol",
    "singleton",
  ],
  information_kinds: ["kind contract", "kind"],
  information_atoms: [
    "information_id kind occurred_at source payload",
    "information_id",
  ],
  information_references: [
    "information_id ordinal relation target_information_id",
    "information_id ordinal",
  ],
  information_log_outbox: [
    "information_id created_at projected_at attempt_count last_error",
    "information_id",
  ],
  information_subscriptions: [
    "subscription_id kind enabled",
    "subscription_id",
  ],
  information_deliveries: [
    "subscription_id information_id state attempts created_at available_at token lease_until",
    "subscription_id information_id",
  ],
  information_commit_slots: [
    "slot_type namespace key information_id",
    "slot_type namespace key",
  ],
  information_schedule_arms: [
    "schedule_information_id due_at state due_information_id terminal_information_id",
    "schedule_information_id",
  ],
  information_lifecycle: [
    "information_id position kind scope_key occurred_at is_open",
    "information_id",
  ],
  information_scope_heads: [
    "namespace scope_key information_id terminal_group",
    "namespace scope_key",
  ],
  memory_raw_events: [
    "information_id kind payload references scope scope_key occurred_at position is_semantic",
    "information_id",
  ],
  memory_raw_checkpoint: ["singleton position", "singleton"],
  memory_raw_rejections: [
    "inbound_information_id position",
    "inbound_information_id",
  ],
  memory_native_epoch: ["id started_at source_after", "id"],
  memory_native_sources: ["id scope source ordinal batch_id", "id"],
  memory_native_batches: [
    "id scope sources status created_at predecessor_id retry_requested",
    "id",
  ],
  memory_native_source_gaps: ["source_id status reason", "source_id"],
  memory_native_stages: ["stage status updated_at", "stage"],
  memory_native_publications: [
    "operation_id input_hash information_id nodes created_at",
    "operation_id",
  ],
  memory_native_search: ["node_id revision analyzer document terms", "node_id"],
  memory_nodes: ["id metadata content", "id"],
  memory_edges: [
    "source_id target_id relation metadata",
    "source_id target_id relation",
  ],
  information_scenes: [
    "scene_id address legacy_scope_key created_at",
    "scene_id",
  ],
  information_observation_progress: [
    "stream_id scene_id consumer_id policy_version contract through_position latest_observation_id discovered_through allocated_through revision",
    "stream_id",
  ],
  information_observations: [
    "observation_id stream_id after_position through_position source_ids context_ids has_more recorded_at status result_information_id error_code operation_key manifest received_through complete deferred_until schedule_information_id replacement_observation_id",
    "observation_id",
  ],
  information_observation_attempts: [
    "observation_id ordinal event detail recorded_at",
    "ordinal",
  ],
  information_action_authorizations: ["id input revoked_id", "id"],
  information_action_runs: ["run_id scope invalidated_id", "run_id"],
  information_action_heads: [
    "intent_id operation_id input digest state attempt_id started_id receipt_id cancellation_id token lease_until legacy_delivery",
    "intent_id",
  ],
  information_action_receipts: [
    "receipt_id intent_id receipt_key",
    "receipt_id",
  ],
  information_action_outbox: ["intent_id started_id acknowledged", "intent_id"],
  information_native_tool_runs: [
    "run_id run_key spec context_id stopped_id steps_count calls_count output_bytes origin_key",
    "run_id",
  ],
  information_native_tool_steps: [
    "run_id step_index frozen_id request_id dispatched_id",
    "run_id step_index",
  ],
  information_native_tool_calls: [
    "run_id step_index call_index call_id completed_id call intent_id result_id",
    "run_id step_index call_index",
  ],
  memory_native_tool_outputs: [
    "operation_id input_hash result",
    "operation_id",
  ],
  // 附加表保留在末尾，baseTables 的前九项继续表示既有基础账本。
  media_resources: [
    "resource_id mime_type sha256 bytes touched_at",
    "resource_id",
  ],
  media_sources: ["media_id scope source_key metadata", "media_id"],
  media_input_snapshots: ["request_key scope snapshot", "request_key"],
};
// 从对应 prepareSchema 的声明核对数据库类型；数组使用 PostgreSQL udt_name。
const columnTypes: Record<string, string> = {
  "media_resources.resource_id": "text!",
  "media_resources.mime_type": "text!",
  "media_resources.sha256": "text!",
  "media_resources.bytes": "bytea!",
  "media_resources.touched_at": "timestamptz!",
  "media_sources.media_id": "text!",
  "media_sources.scope": "text!",
  "media_sources.source_key": "text!",
  "media_sources.metadata": "jsonb!",
  "media_input_snapshots.request_key": "text!",
  "media_input_snapshots.scope": "text!",
  "media_input_snapshots.snapshot": "jsonb!",
  "kaguya_schema_metadata.singleton": "bool!",
  "kaguya_schema_metadata.version": "int4!",
  "kaguya_schema_metadata.information_protocol": "text!",
  "information_kinds.kind": "text!",
  "information_atoms.information_id": "text!",
  "information_atoms.kind": "text!",
  "information_atoms.occurred_at": "text!",
  "information_atoms.source": "text!",
  "information_atoms.payload": "jsonb!",
  "information_references.information_id": "text!",
  "information_references.ordinal": "int4!",
  "information_references.relation": "text!",
  "information_references.target_information_id": "text!",
  "information_log_outbox.information_id": "text!",
  "information_log_outbox.created_at": "timestamptz!",
  "information_log_outbox.projected_at": "timestamptz",
  "information_log_outbox.attempt_count": "int4!",
  "information_log_outbox.last_error": "text",
  "information_subscriptions.subscription_id": "text!",
  "information_subscriptions.kind": "text!",
  "information_subscriptions.enabled": "bool!",
  "information_deliveries.subscription_id": "text!",
  "information_deliveries.information_id": "text!",
  "information_deliveries.state": "text!",
  "information_deliveries.attempts": "int4!",
  "information_deliveries.created_at": "timestamptz!",
  "information_deliveries.available_at": "timestamptz!",
  "information_deliveries.token": "text",
  "information_deliveries.lease_until": "timestamptz",
  "information_commit_slots.slot_type": "text!",
  "information_commit_slots.namespace": "text!",
  "information_commit_slots.key": "text!",
  "information_commit_slots.information_id": "text!",
  "information_schedule_arms.schedule_information_id": "text!",
  "information_schedule_arms.due_at": "timestamptz!",
  "information_schedule_arms.state": "text!",
  "information_schedule_arms.due_information_id": "text",
  "information_schedule_arms.terminal_information_id": "text",
  "memory_raw_events.information_id": "text!",
  "memory_raw_events.kind": "text!",
  "memory_raw_events.payload": "jsonb!",
  "memory_raw_events.references": "jsonb!",
  "memory_raw_events.scope": "jsonb",
  "memory_raw_events.scope_key": "text",
  "memory_raw_events.occurred_at": "timestamptz!",
  "memory_raw_events.position": "int8!",
  "memory_raw_events.is_semantic": "bool!",
  "memory_raw_checkpoint.singleton": "bool!",
  "memory_raw_checkpoint.position": "int8!",
  "memory_raw_rejections.inbound_information_id": "text!",
  "memory_raw_rejections.position": "int8!",
  "information_lifecycle.information_id": "text!",
  "information_lifecycle.kind": "text!",
  "information_lifecycle.scope_key": "text",
  "information_lifecycle.occurred_at": "timestamptz!",
  "information_lifecycle.position": "int8!",
  "information_lifecycle.is_open": "bool!",
  "information_scope_heads.namespace": "text!",
  "information_scope_heads.scope_key": "text!",
  "information_scope_heads.information_id": "text",
  "information_scope_heads.terminal_group": "text!",
  "information_kinds.contract": "jsonb",
  "memory_nodes.id": "uuid!",
  "memory_nodes.metadata": "jsonb!",
  "memory_nodes.content": "text!",
  "memory_edges.source_id": "uuid!",
  "memory_edges.target_id": "uuid!",
  "memory_edges.relation": "text!",
  "memory_edges.metadata": "jsonb!",
  "memory_native_epoch.id": "bool!",
  "memory_native_epoch.started_at": "timestamptz!",
  "memory_native_epoch.source_after": "int8!",
  "memory_native_sources.id": "text!",
  "memory_native_sources.scope": "text!",
  "memory_native_sources.source": "jsonb!",
  "memory_native_sources.ordinal": "int8!",
  "memory_native_sources.batch_id": "uuid",
  "memory_native_source_gaps.source_id": "text!",
  "memory_native_source_gaps.status": "text!",
  "memory_native_source_gaps.reason": "text!",
  "memory_native_batches.id": "uuid!",
  "memory_native_batches.scope": "text!",
  "memory_native_batches.sources": "jsonb!",
  "memory_native_batches.status": "text!",
  "memory_native_batches.created_at": "timestamptz!",
  "memory_native_stages.stage": "text!",
  "memory_native_stages.status": "text!",
  "memory_native_stages.updated_at": "timestamptz!",
  "memory_native_publications.operation_id": "text!",
  "memory_native_publications.input_hash": "text!",
  "memory_native_publications.information_id": "text!",
  "memory_native_publications.nodes": "jsonb!",
  "memory_native_publications.created_at": "timestamptz!",
  "memory_native_search.node_id": "uuid!",
  "memory_native_search.revision": "int4!",
  "memory_native_search.analyzer": "text!",
  "memory_native_search.document": "tsvector!",
  "memory_native_search.terms": "_text!",
  "memory_native_batches.predecessor_id": "uuid",
  "memory_native_batches.retry_requested": "bool!",
  "information_scenes.scene_id": "text!",
  "information_scenes.address": "jsonb!",
  "information_scenes.legacy_scope_key": "text!",
  "information_scenes.created_at": "timestamptz!",
  "information_observation_progress.stream_id": "text!",
  "information_observation_progress.scene_id": "text!",
  "information_observation_progress.consumer_id": "text!",
  "information_observation_progress.policy_version": "text!",
  "information_observation_progress.contract": "jsonb!",
  "information_observation_progress.through_position": "int8!",
  "information_observation_progress.latest_observation_id": "text",
  "information_observations.observation_id": "text!",
  "information_observations.stream_id": "text!",
  "information_observations.after_position": "int8!",
  "information_observations.through_position": "int8!",
  "information_observations.source_ids": "jsonb!",
  "information_observations.context_ids": "jsonb!",
  "information_observations.has_more": "bool!",
  "information_observations.recorded_at": "timestamptz!",
  "information_observations.status": "text!",
  "information_observations.result_information_id": "text",
  "information_observations.error_code": "text",
  "information_observation_attempts.observation_id": "text!",
  "information_observation_attempts.ordinal": "int8!",
  "information_observation_attempts.event": "text!",
  "information_observation_attempts.detail": "jsonb!",
  "information_observation_attempts.recorded_at": "timestamptz!",
  "information_observation_progress.discovered_through": "int8!",
  "information_observation_progress.allocated_through": "int8!",
  "information_observation_progress.revision": "int4!",
  "information_observations.operation_key": "text",
  "information_observations.manifest": "jsonb",
  "information_observations.received_through": "int8",
  "information_observations.complete": "bool!",
  "information_observations.deferred_until": "timestamptz",
  "information_observations.schedule_information_id": "text",
  "information_observations.replacement_observation_id": "text",
  "information_action_authorizations.id": "text!",
  "information_action_authorizations.input": "jsonb!",
  "information_action_authorizations.revoked_id": "text",
  "information_action_runs.run_id": "text!",
  "information_action_runs.scope": "text!",
  "information_action_runs.invalidated_id": "text",
  "information_action_heads.intent_id": "text!",
  "information_action_heads.operation_id": "text!",
  "information_action_heads.input": "jsonb!",
  "information_action_heads.digest": "text!",
  "information_action_heads.state": "text!",
  "information_action_heads.attempt_id": "text",
  "information_action_heads.started_id": "text",
  "information_action_heads.receipt_id": "text",
  "information_action_heads.cancellation_id": "text",
  "information_action_heads.token": "text",
  "information_action_heads.lease_until": "timestamptz",
  "information_action_heads.legacy_delivery": "bool!",
  "information_action_receipts.receipt_id": "text!",
  "information_action_receipts.intent_id": "text!",
  "information_action_receipts.receipt_key": "text!",
  "information_action_outbox.intent_id": "text!",
  "information_action_outbox.started_id": "text!",
  "information_action_outbox.acknowledged": "bool!",
  "information_native_tool_runs.run_id": "text!",
  "information_native_tool_runs.run_key": "text!",
  "information_native_tool_runs.spec": "jsonb!",
  "information_native_tool_runs.context_id": "text!",
  "information_native_tool_runs.stopped_id": "text",
  "information_native_tool_runs.steps_count": "int4!",
  "information_native_tool_runs.calls_count": "int4!",
  "information_native_tool_runs.output_bytes": "int4!",
  "information_native_tool_steps.run_id": "text!",
  "information_native_tool_steps.step_index": "int4!",
  "information_native_tool_steps.frozen_id": "text!",
  "information_native_tool_steps.request_id": "text",
  "information_native_tool_steps.dispatched_id": "text",
  "information_native_tool_calls.run_id": "text!",
  "information_native_tool_calls.step_index": "int4!",
  "information_native_tool_calls.call_index": "int4!",
  "information_native_tool_calls.call_id": "text!",
  "information_native_tool_calls.completed_id": "text!",
  "information_native_tool_calls.call": "jsonb!",
  "information_native_tool_calls.intent_id": "text",
  "information_native_tool_calls.result_id": "text",
  "information_native_tool_runs.origin_key": "text",
  "memory_native_tool_outputs.operation_id": "text!",
  "memory_native_tool_outputs.input_hash": "text!",
  "memory_native_tool_outputs.result": "jsonb!",
};
const incrementalColumns = new Set([
  "information_kinds.contract",
  "memory_native_batches.predecessor_id",
  "memory_native_batches.retry_requested",
  "information_native_tool_runs.origin_key",
  ..."discovered_through allocated_through revision"
    .split(" ")
    .map((c) => `information_observation_progress.${c}`),
  ..."operation_key manifest received_through complete deferred_until schedule_information_id replacement_observation_id"
    .split(" ")
    .map((c) => `information_observations.${c}`),
]);
const indexes: Record<string, readonly [string, boolean, string]> = {
  information_action_recovery: [
    "information_action_heads",
    false,
    "state, lease_until",
  ],
  information_native_tool_origin: [
    "information_native_tool_runs",
    true,
    "origin_key",
  ],
  information_observations_operation_idx: [
    "information_observations",
    true,
    "stream_id, operation_key",
  ],
  information_observations_scene_idx: [
    "information_observations",
    false,
    "stream_id, through_position DESC",
  ],
  information_lifecycle_position_idx: [
    "information_lifecycle",
    true,
    "position",
  ],
};
const requiredUnique: Record<string, string[]> = {
  media_sources: ["scope source_key"],
  information_action_heads: ["operation_id"],
  information_action_receipts: ["receipt_key"],
  information_native_tool_runs: ["run_key"],
  information_native_tool_calls: ["run_id step_index call_id"],
};
const requiredForeignKeys: Record<string, string[]> = {
  information_scenes: [],
  information_observation_progress: ["scene_id:information_scenes:scene_id"],
  information_observations: [
    "stream_id:information_observation_progress:stream_id",
    "result_information_id:information_atoms:information_id",
  ],
  information_observation_attempts: [
    "observation_id:information_observations:observation_id",
  ],
  information_action_authorizations: [
    "revoked_id:information_atoms:information_id",
  ],
  information_action_runs: [
    "run_id:information_atoms:information_id",
    "invalidated_id:information_atoms:information_id",
  ],
  information_action_heads: [
    "intent_id:information_atoms:information_id",
    "started_id:information_atoms:information_id",
    "receipt_id:information_atoms:information_id",
    "cancellation_id:information_atoms:information_id",
  ],
  information_action_receipts: [
    "receipt_id:information_atoms:information_id",
    "intent_id:information_action_heads:intent_id",
  ],
  information_action_outbox: [
    "intent_id:information_action_heads:intent_id",
    "started_id:information_atoms:information_id",
  ],
  information_native_tool_runs: [
    "run_id:information_atoms:information_id",
    "context_id:information_atoms:information_id",
    "stopped_id:information_atoms:information_id",
  ],
  information_native_tool_steps: [
    "run_id:information_native_tool_runs:run_id",
    "frozen_id:information_atoms:information_id",
    "dispatched_id:information_atoms:information_id",
  ],
  information_native_tool_calls: [
    "run_id step_index:information_native_tool_steps:run_id step_index",
    "completed_id:information_atoms:information_id",
    "intent_id:information_action_heads:intent_id",
    "result_id:information_atoms:information_id",
  ],
};
const minimumChecks: Record<string, number> = {
  media_resources: 1,
  kaguya_schema_metadata: 3,
  information_deliveries: 2,
  information_commit_slots: 1,
  memory_raw_checkpoint: 1,
  memory_native_epoch: 1,
  memory_nodes: 2,
  memory_edges: 2,
  information_observations: 2,
};
export async function inspectOfflineSchema(
  db: Reader,
  complete: boolean,
): Promise<string[]> {
  const columns = (
    await db.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: string;
    }>(
      "SELECT table_name,column_name,udt_name,is_nullable FROM information_schema.columns WHERE table_schema=current_schema()",
    )
  ).rows;
  const actual = new Map<string, Set<string>>();
  for (const c of columns) {
    if (!actual.has(c.table_name)) actual.set(c.table_name, new Set());
    actual.get(c.table_name)!.add(c.column_name);
  }
  const errors: string[] = [];
  for (const c of columns) {
    const expected = columnTypes[`${c.table_name}.${c.column_name}`];
    if (
      expected &&
      (c.udt_name !== expected.replace(/!$/, "") ||
        (expected.endsWith("!") && c.is_nullable !== "NO"))
    )
      errors.push(`type:${c.table_name}.${c.column_name}`);
  }
  const baseTables = Object.keys(tables).slice(0, 9);
  if (baseTables.some((t) => !actual.has(t)))
    errors.push("base-schema-missing");
  // 旧来源双表先于字节表引入，可增量补齐；字节表孤立存在不属于合法阶段。
  if (
    actual.has("media_resources") &&
    (!actual.has("media_sources") || !actual.has("media_input_snapshots"))
  )
    errors.push("partial-schema-stage");
  for (const group of [
    ["media_sources", "media_input_snapshots"],
    ["information_lifecycle", "information_scope_heads"],
    [
      "information_action_authorizations",
      "information_action_runs",
      "information_action_heads",
      "information_action_receipts",
      "information_action_outbox",
    ],
    [
      "information_native_tool_runs",
      "information_native_tool_steps",
      "information_native_tool_calls",
    ],
  ])
    if (group.some((t) => actual.has(t)) && !group.every((t) => actual.has(t)))
      errors.push("partial-schema-stage");
  const raw = [
    "memory_raw_events",
    "memory_raw_checkpoint",
    "memory_raw_rejections",
  ];
  if (raw.some((t) => actual.has(t)) && !raw.every((t) => actual.has(t)))
    errors.push("partial-raw-schema");
  if (
    [...actual.keys()].some((t) => t.startsWith("memory_native_")) &&
    !actual.has("memory_native_epoch")
  )
    errors.push("epoch-missing");
  if (actual.has("memory_native_epoch")) {
    const epoch = (
      await db.query<{ count: string }>(
        "SELECT count(*)::text count FROM memory_native_epoch WHERE id=true",
      )
    ).rows[0];
    if (epoch?.count !== "1") errors.push("epoch-missing");
  }
  const constraints = (
    await db.query<{
      table_name: string;
      type: string;
      columns: string;
      target: string | null;
      target_columns: string | null;
      expression: string | null;
    }>(`
    SELECT r.relname table_name,c.contype type,pg_get_expr(c.conbin,c.conrelid) expression,
      array_to_string(ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.o),' ') columns,
      t.relname target,
      array_to_string(ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.o),' ') target_columns
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    LEFT JOIN pg_class t ON t.oid=c.confrelid WHERE n.nspname=current_schema() AND c.contype IN ('p','u','f','c') AND c.convalidated AND (c.contype<>'f' OR t.relnamespace=r.relnamespace)
  `)
  ).rows;
  for (const [table, [required, primary]] of Object.entries(tables)) {
    const found = actual.get(table);
    if (!found) {
      if (complete) errors.push(`table:${table}`);
      continue;
    }
    for (const column of required.split(" ")) {
      if (
        !found.has(column) &&
        (complete || !incrementalColumns.has(`${table}.${column}`))
      )
        errors.push(`column:${table}.${column}`);
    }
    if (
      !constraints.some(
        (c) =>
          c.table_name === table && c.type === "p" && c.columns === primary,
      )
    )
      errors.push(`primary:${table}`);
    if (
      constraints.filter((c) => c.table_name === table && c.type === "c")
        .length < (minimumChecks[table] ?? 0)
    )
      errors.push(`checks:${table}`);
    for (const unique of requiredUnique[table] ?? [])
      if (
        !constraints.some(
          (c) =>
            c.table_name === table && c.type === "u" && c.columns === unique,
        )
      )
        errors.push(`unique:${table}`);
    for (const fk of requiredForeignKeys[table] ?? [])
      if (
        !constraints.some(
          (c) =>
            c.table_name === table &&
            c.type === "f" &&
            `${c.columns}:${c.target}:${c.target_columns}` === fk,
        )
      )
        errors.push(`foreign-key:${table}`);
  }
  if (
    actual.has("media_resources") &&
    !constraints.some(
      (constraint) =>
        constraint.table_name === "media_resources" &&
        constraint.type === "c" &&
        constraint.expression?.replace(/[\s()]/g, "") ===
          "octet_lengthbytes>0ANDoctet_lengthbytes<=16777216",
    )
  )
    errors.push("check-expression:media_resources.bytes");
  const foundIndexes = (
    await db.query<{
      name: string;
      table_name: string;
      is_unique: boolean;
      definition: string;
      valid: boolean;
    }>(`
    SELECT i.relname name,t.relname table_name,x.indisunique is_unique,pg_get_indexdef(i.oid) definition,x.indisvalid valid
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema()
  `)
  ).rows;
  for (const [name, [table, unique, keys]] of Object.entries(indexes)) {
    const existing = foundIndexes.find((i) => i.name === name);
    if (!existing && complete) errors.push(`index:${name}`);
    if (
      existing &&
      (!existing.valid ||
        existing.table_name !== table ||
        existing.is_unique !== unique ||
        existing.definition
          .replace(/"([a-z_][a-z0-9_]*)"/g, "$1")
          .match(/ USING btree \(([^()]*)\)$/)?.[1] !== keys)
    )
      errors.push(`index:${name}`);
  }
  for (const name of [
    "information_deliveries_pending_idx",
    "information_schedule_arms_open_due_idx",
    "information_atoms_kind_occurred_at_idx",
    "information_atoms_source_occurred_at_idx",
    "information_references_target_relation_idx",
    "information_log_outbox_pending_idx",
  ])
    if (!foundIndexes.some((index) => index.name === name && index.valid))
      errors.push(`index:${name}`);
  const triggers = (
    await db.query<{ name: string; enabled: string }>(
      "SELECT t.tgname name,t.tgenabled enabled FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal",
    )
  ).rows;
  for (const name of [
    "information_atoms_reject_mutation",
    "information_references_reject_mutation",
  ])
    if (
      !triggers.some(
        (trigger) =>
          trigger.name === name && ["O", "A"].includes(trigger.enabled),
      )
    )
      errors.push(`trigger:${name}`);
  return [...new Set(errors)].sort();
}
