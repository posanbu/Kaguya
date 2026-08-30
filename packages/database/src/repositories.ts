import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import {
  eventRunSchema,
  llmTraceSchema,
  messageRecordSchema,
  outboundMessageRecordSchema,
  type EventRun,
  type LlmTrace,
  type MessageRecord,
  type OutboundMessageRecord,
} from "@kaguya/schema";

type SqlRow = Record<string, SQLOutputValue>;

export class DatabaseRecordError extends Error {
  readonly table: string;
  readonly recordId: string;

  constructor(
    table: string,
    recordId: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid ${table} record ${recordId}: ${reason}`, options);
    this.name = "DatabaseRecordError";
    this.table = table;
    this.recordId = recordId;
  }
}

export class EventRunLifecycleError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Event run ${runId} has an invalid lifecycle transition`);
    this.name = "EventRunLifecycleError";
    this.runId = runId;
  }
}

export class MessageRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(record: MessageRecord): void {
    this.database
      .prepare(
        `INSERT INTO messages (id, role, content, occurred_at, metadata_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.role,
        record.content,
        record.occurredAt,
        stringifyJson(record.metadata),
      );
  }

  getById(id: string): MessageRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, role, content, occurred_at, metadata_json
         FROM messages WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? undefined : readMessage(row);
  }

  listRecent(limit: number): MessageRecord[] {
    assertRecentLimit(limit);
    return this.database
      .prepare(
        `SELECT id, role, content, occurred_at, metadata_json
         FROM messages ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => readMessage(row));
  }
}

export class OutboundMessageRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(
    record: Extract<OutboundMessageRecord, { status: "requested" }>,
  ): void {
    this.database
      .prepare(
        `INSERT INTO outbound_messages (
          id, trace_id, adapter_id, platform, destination_json, message_json,
          occurred_at, completed_at, status, receipt_json, error, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'requested', NULL, NULL, ?)`,
      )
      .run(
        record.id,
        record.traceId,
        record.adapterId,
        record.platform,
        stringifyJson(record.destination),
        stringifyJson(record.message),
        record.occurredAt,
        stringifyJson(record.metadata),
      );
  }

  complete(
    record:
      | Extract<OutboundMessageRecord, { status: "delivered" }>
      | Extract<OutboundMessageRecord, { status: "failed" }>,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE outbound_messages SET
          completed_at = ?, status = ?, receipt_json = ?, error = ?
         WHERE id = ? AND status = 'requested'`,
      )
      .run(
        record.completedAt,
        record.status,
        record.status === "delivered" ? stringifyJson(record.receipt) : null,
        record.status === "failed" ? record.error : null,
        record.id,
      );
    if (result.changes !== 1) {
      throw new DatabaseRecordError(
        "outbound_messages",
        record.id,
        "invalid lifecycle transition",
      );
    }
  }

  getById(id: string): OutboundMessageRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, trace_id, adapter_id, platform, destination_json,
          message_json, occurred_at, completed_at, status, receipt_json,
          error, metadata_json FROM outbound_messages WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? undefined : readOutboundMessage(row);
  }

  listByTrace(traceId: string): OutboundMessageRecord[] {
    return this.database
      .prepare(
        `SELECT id, trace_id, adapter_id, platform, destination_json,
          message_json, occurred_at, completed_at, status, receipt_json,
          error, metadata_json FROM outbound_messages
         WHERE trace_id = ? ORDER BY occurred_at ASC, id ASC`,
      )
      .all(traceId)
      .map((row) => readOutboundMessage(row));
  }
}

export class EventRunRepository {
  constructor(private readonly database: DatabaseSync) {}

  async record(run: EventRun): Promise<void> {
    const result = this.database
      .prepare(
        `INSERT INTO event_runs (
          id, trace_id, workflow_id, node_id, started_at, completed_at, status,
          output_json, retryable, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          completed_at = excluded.completed_at,
          status = excluded.status,
          output_json = excluded.output_json,
          retryable = excluded.retryable,
          error_json = excluded.error_json
        WHERE event_runs.status = 'running'
          AND excluded.status <> 'running'
          AND event_runs.trace_id = excluded.trace_id
          AND event_runs.workflow_id = excluded.workflow_id
          AND event_runs.node_id = excluded.node_id
          AND event_runs.started_at = excluded.started_at`,
      )
      .run(
        run.id,
        run.traceId,
        run.workflowId,
        run.nodeId,
        run.startedAt,
        "completedAt" in run ? run.completedAt : null,
        run.status,
        run.status === "completed" ? stringifyJson(run.output) : null,
        run.status === "failed" ? Number(run.retryable) : null,
        run.status === "failed" ? stringifyJson(run.error) : null,
      );

    if (result.changes !== 1) {
      throw new EventRunLifecycleError(run.id);
    }
  }

  deleteByTraceIds(traceIds: readonly string[]): void {
    deleteTraceRows(this.database, "event_runs", traceIds);
  }

  listByTrace(traceId: string): EventRun[] {
    return this.database
      .prepare(
        `SELECT id, trace_id, workflow_id, node_id, started_at, completed_at, status,
          output_json, retryable, error_json
         FROM event_runs WHERE trace_id = ? ORDER BY started_at ASC, id ASC`,
      )
      .all(traceId)
      .map((row) => readEventRun(row));
  }
}

export class LlmTraceRepository {
  constructor(private readonly database: DatabaseSync) {}

  async write(trace: LlmTrace): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO llm_traces (
          id, trace_id, workflow_id, node_id, kind, model_id, causation_event_id,
          root_event_id, prompt_json, started_at, completed_at, duration_ms,
          status, response_json, usage_json, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.id,
        trace.traceId,
        trace.workflowId,
        trace.nodeId,
        trace.kind,
        trace.modelId,
        trace.causationEventId ?? null,
        trace.rootEventId ?? null,
        stringifyJson(trace.prompt),
        trace.startedAt,
        trace.completedAt,
        trace.durationMs,
        trace.status,
        trace.status === "completed" ? stringifyJson(trace.response) : null,
        trace.usage === undefined ? null : stringifyJson(trace.usage),
        trace.status === "failed" ? stringifyJson(trace.error) : null,
      );
  }

  deleteByTraceIds(traceIds: readonly string[]): void {
    deleteTraceRows(this.database, "llm_traces", traceIds);
  }

  listByTrace(traceId: string): LlmTrace[] {
    return this.database
      .prepare(
        `SELECT id, trace_id, workflow_id, node_id, kind, model_id,
          causation_event_id, root_event_id, prompt_json, started_at,
          completed_at, duration_ms, status, response_json, usage_json, error_json
         FROM llm_traces WHERE trace_id = ? ORDER BY started_at ASC, id ASC`,
      )
      .all(traceId)
      .map((row) => readLlmTrace(row));
  }
}

function readMessage(row: SqlRow): MessageRecord {
  const id = requiredString(row, "id", "messages", "<unknown>");
  return reconstructRecord("messages", id, () =>
    messageRecordSchema.parse({
      id,
      role: requiredString(row, "role", "messages", id),
      content: requiredString(row, "content", "messages", id),
      occurredAt: requiredString(row, "occurred_at", "messages", id),
      metadata: parseJson(row, "metadata_json", "messages", id),
    }),
  );
}

function readOutboundMessage(row: SqlRow): OutboundMessageRecord {
  const id = requiredString(row, "id", "outbound_messages", "<unknown>");
  return reconstructRecord("outbound_messages", id, () => {
    const status = requiredString(row, "status", "outbound_messages", id);
    const base = {
      id,
      traceId: requiredString(row, "trace_id", "outbound_messages", id),
      adapterId: requiredString(row, "adapter_id", "outbound_messages", id),
      platform: requiredString(row, "platform", "outbound_messages", id),
      destination: parseJson(row, "destination_json", "outbound_messages", id),
      message: parseJson(row, "message_json", "outbound_messages", id),
      occurredAt: requiredString(row, "occurred_at", "outbound_messages", id),
      metadata: parseJson(row, "metadata_json", "outbound_messages", id),
      status,
    };
    if (status === "requested") {
      return outboundMessageRecordSchema.parse(base);
    }
    const completedAt = requiredString(
      row,
      "completed_at",
      "outbound_messages",
      id,
    );
    return outboundMessageRecordSchema.parse(
      status === "delivered"
        ? {
            ...base,
            completedAt,
            receipt: parseJson(row, "receipt_json", "outbound_messages", id),
          }
        : {
            ...base,
            completedAt,
            error: requiredString(row, "error", "outbound_messages", id),
          },
    );
  });
}

function readEventRun(row: SqlRow): EventRun {
  const id = requiredString(row, "id", "event_runs", "<unknown>");
  return reconstructRecord("event_runs", id, () => {
    const status = requiredString(row, "status", "event_runs", id);
    const base = {
      id,
      traceId: requiredString(row, "trace_id", "event_runs", id),
      workflowId: requiredString(row, "workflow_id", "event_runs", id),
      nodeId: requiredString(row, "node_id", "event_runs", id),
      startedAt: requiredString(row, "started_at", "event_runs", id),
      status,
    };

    if (status === "running") {
      return eventRunSchema.parse(base);
    }
    if (status === "completed") {
      return eventRunSchema.parse({
        ...base,
        completedAt: requiredString(row, "completed_at", "event_runs", id),
        output: parseJson(row, "output_json", "event_runs", id),
      });
    }
    if (status === "failed") {
      return eventRunSchema.parse({
        ...base,
        completedAt: requiredString(row, "completed_at", "event_runs", id),
        retryable: requiredNumber(row, "retryable", "event_runs", id) === 1,
        error: parseJson(row, "error_json", "event_runs", id),
      });
    }
    return eventRunSchema.parse({
      ...base,
      completedAt: requiredString(row, "completed_at", "event_runs", id),
    });
  });
}

function readLlmTrace(row: SqlRow): LlmTrace {
  const id = requiredString(row, "id", "llm_traces", "<unknown>");
  return reconstructRecord("llm_traces", id, () => {
    const status = requiredString(row, "status", "llm_traces", id);
    const causationEventId = optionalString(
      row,
      "causation_event_id",
      "llm_traces",
      id,
    );
    const rootEventId = optionalString(row, "root_event_id", "llm_traces", id);
    const base = {
      id,
      traceId: requiredString(row, "trace_id", "llm_traces", id),
      workflowId: requiredString(row, "workflow_id", "llm_traces", id),
      nodeId: requiredString(row, "node_id", "llm_traces", id),
      kind: requiredString(row, "kind", "llm_traces", id),
      modelId: requiredString(row, "model_id", "llm_traces", id),
      ...(causationEventId === undefined ? {} : { causationEventId }),
      ...(rootEventId === undefined ? {} : { rootEventId }),
      prompt: parseJson(row, "prompt_json", "llm_traces", id),
      startedAt: requiredString(row, "started_at", "llm_traces", id),
      completedAt: requiredString(row, "completed_at", "llm_traces", id),
      durationMs: requiredNumber(row, "duration_ms", "llm_traces", id),
      status,
      usage: optionalJson(row, "usage_json", "llm_traces", id),
    };

    if (status === "completed") {
      const { usage, ...withoutUsage } = base;
      return llmTraceSchema.parse({
        ...withoutUsage,
        ...(usage === undefined ? {} : { usage }),
        response: parseJson(row, "response_json", "llm_traces", id),
      });
    }

    const { usage, ...withoutUsage } = base;
    return llmTraceSchema.parse({
      ...withoutUsage,
      ...(usage === undefined ? {} : { usage }),
      error: parseJson(row, "error_json", "llm_traces", id),
    });
  });
}

function assertRecentLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("limit must be a nonnegative safe integer");
  }
}

function deleteTraceRows(
  database: DatabaseSync,
  table: "event_runs" | "llm_traces",
  traceIds: readonly string[],
): void {
  if (traceIds.length === 0) {
    return;
  }

  const placeholders = traceIds.map(() => "?").join(", ");
  database
    .prepare(`DELETE FROM ${table} WHERE trace_id IN (${placeholders})`)
    .run(...traceIds);
}

function reconstructRecord<T>(
  table: string,
  recordId: string,
  reconstruct: () => T,
): T {
  try {
    return reconstruct();
  } catch (error) {
    if (error instanceof DatabaseRecordError) {
      throw error;
    }
    throw new DatabaseRecordError(table, recordId, "failed schema validation", {
      cause: error,
    });
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function parseJson(
  row: SqlRow,
  column: string,
  table: string,
  recordId: string,
): unknown {
  const value = requiredString(row, column, table, recordId);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new DatabaseRecordError(
      table,
      recordId,
      `malformed JSON in ${column}`,
      {
        cause: error,
      },
    );
  }
}

function optionalJson(
  row: SqlRow,
  column: string,
  table: string,
  recordId: string,
): unknown | undefined {
  if (row[column] === null) {
    return undefined;
  }
  return parseJson(row, column, table, recordId);
}

function requiredString(
  row: SqlRow,
  column: string,
  table: string,
  recordId: string,
): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new DatabaseRecordError(
      table,
      recordId,
      `missing text column ${column}`,
    );
  }
  return value;
}

function optionalString(
  row: SqlRow,
  column: string,
  table: string,
  recordId: string,
): string | undefined {
  return row[column] === null
    ? undefined
    : requiredString(row, column, table, recordId);
}

function requiredNumber(
  row: SqlRow,
  column: string,
  table: string,
  recordId: string,
): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new DatabaseRecordError(
      table,
      recordId,
      `missing numeric column ${column}`,
    );
  }
  return value;
}
