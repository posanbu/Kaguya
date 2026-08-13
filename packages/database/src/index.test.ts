import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import type {
  EventRun,
  LlmTrace,
  MemoryRecord,
  MessageRecord,
} from "@kaguya/schema";

import {
  DatabaseRecordError,
  EventRunLifecycleError,
  KaguyaDatabase,
} from "./index.js";

const prompt = {
  kind: "reply" as const,
  text: '<policy source="policy-1">be helpful</policy>',
  fragments: [
    {
      id: "policy-1",
      source: "policy" as const,
      priority: 100,
      content: "be helpful",
      metadata: { revision: 2 },
    },
  ],
  provenance: [
    {
      fragmentId: "policy-1",
      source: "policy" as const,
      priority: 100,
      contentDigest: "sha256:example",
    },
  ],
};

function withDatabase(
  callback: (database: KaguyaDatabase) => void | Promise<void>,
) {
  const database = KaguyaDatabase.open(":memory:");
  database.migrate();

  return Promise.resolve(callback(database)).finally(() => database.close());
}

describe("KaguyaDatabase messages", () => {
  it("returns only the latest session messages", () =>
    withDatabase((database) => {
      const first: MessageRecord = {
        id: "message-1",
        sessionId: "session-1",
        role: "user",
        content: "first",
        occurredAt: "2026-07-23T00:00:00.000Z",
        metadata: { source: "test" },
      };
      const latest: MessageRecord = {
        ...first,
        id: "message-2",
        content: "latest",
        occurredAt: "2026-07-23T00:01:00.000Z",
      };

      database.messages.insert(first);
      database.messages.insert(latest);

      expect(database.messages.listRecent("session-1", 1)).toEqual([latest]);
      expect(database.messages.getById(first.id)).toEqual(first);
      expect(database.messages.getById("message-missing")).toBeUndefined();
    }));
});

describe("KaguyaDatabase migrations", () => {
  it("records each migration version once when migration is repeated", () => {
    const directory = mkdtempSync(join(tmpdir(), "kaguya-database-"));
    const path = join(directory, "kaguya.sqlite");

    try {
      const database = KaguyaDatabase.open(path);
      database.migrate();
      database.migrate();
      database.messages.insert({
        id: "message-after-repeat-migration",
        sessionId: "session-1",
        role: "system",
        content: "ready",
        occurredAt: "2026-07-23T00:00:00.000Z",
        metadata: {},
      });
      expect(database.messages.listRecent("session-1", 1)).toHaveLength(1);
      database.close();

      const sqlite = new DatabaseSync(path);
      expect(
        sqlite
          .prepare(
            "SELECT version, COUNT(*) AS migration_count FROM schema_migrations GROUP BY version",
          )
          .all(),
      ).toEqual([{ version: 1, migration_count: 1 }]);
      sqlite.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("KaguyaDatabase memories", () => {
  it("returns memories within an inclusive session time window", () =>
    withDatabase((database) => {
      const memory: MemoryRecord = {
        id: "memory-1",
        sessionId: "session-1",
        content: "remember this",
        occurredAt: "2026-07-23T00:01:00.000Z",
        metadata: { importance: 0.7 },
      };
      database.memories.insert({
        ...memory,
        id: "memory-before",
        occurredAt: "2026-07-23T00:00:00.000Z",
      });
      database.memories.insert(memory);
      database.memories.insert({
        ...memory,
        id: "memory-after",
        occurredAt: "2026-07-23T00:02:00.000Z",
      });

      expect(
        database.memories.listWindow(
          "session-1",
          "2026-07-23T00:01:00.000Z",
          "2026-07-23T00:01:00.000Z",
        ),
      ).toEqual([memory]);
    }));
});

describe("KaguyaDatabase execution records", () => {
  it("round-trips event-run and LLM trace JSON without losing provenance", async () =>
    withDatabase(async (database) => {
      const eventRun: EventRun = {
        id: "event-run-1",
        traceId: "trace-1",
        workflowId: "workflow-1",
        nodeId: "node-1",
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:00.010Z",
        status: "completed",
        output: { messages: ["hello"], nested: { count: 1 } },
      };
      const llmTrace: LlmTrace = {
        id: "llm-trace-1",
        traceId: "trace-1",
        workflowId: "workflow-1",
        nodeId: "node-1",
        kind: "reply",
        modelId: "model-1",
        prompt,
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:00.010Z",
        durationMs: 10,
        status: "failed",
        usage: { inputTokens: 10, outputTokens: 5 },
        error: {
          name: "KaguyaLlmError",
          message: "provider unavailable",
          kind: "retryable",
        },
      };

      await database.eventRuns.record(eventRun);
      await database.llmTraces.write(llmTrace);

      expect(database.eventRuns.listByTrace("trace-1")).toEqual([eventRun]);
      expect(database.llmTraces.listByTrace("trace-1")).toEqual([llmTrace]);
    }));
});

describe("event run lifecycle persistence", () => {
  const running: EventRun = {
    id: "event-run-lifecycle",
    traceId: "trace-lifecycle",
    workflowId: "workflow-1",
    nodeId: "node-1",
    startedAt: "2026-07-23T00:00:00.000Z",
    status: "running",
  };

  for (const terminal of [
    {
      ...running,
      completedAt: "2026-07-23T00:00:00.010Z",
      status: "completed" as const,
      output: { result: "ok" },
    },
    {
      ...running,
      completedAt: "2026-07-23T00:00:00.010Z",
      status: "failed" as const,
      retryable: true,
      error: { name: "RetryableError", message: "try again" },
    },
    {
      ...running,
      completedAt: "2026-07-23T00:00:00.010Z",
      status: "cancelled" as const,
    },
  ] satisfies readonly EventRun[]) {
    it(`transitions a running event run to ${terminal.status}`, async () =>
      withDatabase(async (database) => {
        await database.eventRuns.record(running);

        await expect(
          database.eventRuns.record(terminal),
        ).resolves.toBeUndefined();
        expect(database.eventRuns.listByTrace(running.traceId)).toEqual([
          terminal,
        ]);
      }));
  }

  it("rejects duplicate running lifecycle writes with a typed error", async () =>
    withDatabase(async (database) => {
      await database.eventRuns.record(running);

      await expect(database.eventRuns.record(running)).rejects.toBeInstanceOf(
        EventRunLifecycleError,
      );
    }));

  it("rejects writes after an event run reaches a terminal state", async () =>
    withDatabase(async (database) => {
      const completed: EventRun = {
        ...running,
        completedAt: "2026-07-23T00:00:00.010Z",
        status: "completed",
        output: { result: "ok" },
      };
      await database.eventRuns.record(completed);

      await expect(database.eventRuns.record(completed)).rejects.toBeInstanceOf(
        EventRunLifecycleError,
      );
    }));

  for (const [field, terminal] of [
    [
      "traceId",
      {
        ...running,
        traceId: "trace-other",
        completedAt: "2026-07-23T00:00:00.010Z",
        status: "completed" as const,
        output: { result: "ok" },
      },
    ],
    [
      "workflowId",
      {
        ...running,
        workflowId: "workflow-other",
        completedAt: "2026-07-23T00:00:00.010Z",
        status: "completed" as const,
        output: { result: "ok" },
      },
    ],
    [
      "nodeId",
      {
        ...running,
        nodeId: "node-other",
        completedAt: "2026-07-23T00:00:00.010Z",
        status: "completed" as const,
        output: { result: "ok" },
      },
    ],
    [
      "startedAt",
      {
        ...running,
        startedAt: "2026-07-23T00:00:00.001Z",
        completedAt: "2026-07-23T00:00:00.010Z",
        status: "completed" as const,
        output: { result: "ok" },
      },
    ],
  ] satisfies readonly [string, EventRun][]) {
    it(`rejects a terminal transition with a mismatched ${field}`, async () =>
      withDatabase(async (database) => {
        await database.eventRuns.record(running);

        await expect(
          database.eventRuns.record(terminal),
        ).rejects.toBeInstanceOf(EventRunLifecycleError);
        expect(database.eventRuns.listByTrace(running.traceId)).toEqual([
          running,
        ]);
      }));
  }
});

describe("recent-record limits", () => {
  it("accepts zero and rejects unsafe message limits before executing SQL", () =>
    withDatabase((database) => {
      expect(database.messages.listRecent("session-1", 0)).toEqual([]);
      for (const limit of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => database.messages.listRecent("session-1", limit)).toThrow(
          RangeError,
        );
      }
    }));

  it("accepts zero and rejects unsafe memory limits before executing SQL", () =>
    withDatabase((database) => {
      expect(database.memories.listRecent("session-1", 0)).toEqual([]);
      for (const limit of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => database.memories.listRecent("session-1", limit)).toThrow(
          RangeError,
        );
      }
    }));
});

describe("database record decoding", () => {
  it("identifies the table and record when stored JSON is malformed", () => {
    const directory = mkdtempSync(join(tmpdir(), "kaguya-database-"));
    const path = join(directory, "kaguya.sqlite");

    try {
      const database = KaguyaDatabase.open(path);
      database.migrate();
      database.messages.insert({
        id: "message-malformed-json",
        sessionId: "session-1",
        role: "user",
        content: "hello",
        occurredAt: "2026-07-23T00:00:00.000Z",
        metadata: {},
      });
      database.close();

      const sqlite = new DatabaseSync(path);
      sqlite
        .prepare("UPDATE messages SET metadata_json = ? WHERE id = ?")
        .run("{", "message-malformed-json");
      sqlite.close();

      const reopened = KaguyaDatabase.open(path);
      try {
        expect(() => reopened.messages.listRecent("session-1", 1)).toThrow(
          DatabaseRecordError,
        );
        expect(() => reopened.messages.listRecent("session-1", 1)).toThrow(
          /messages.*message-malformed-json/,
        );
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("wraps valid JSON with an invalid message metadata shape", () => {
    withCorruptedDatabase((database, path) => {
      database.messages.insert({
        id: "message-invalid-metadata",
        sessionId: "session-1",
        role: "user",
        content: "hello",
        occurredAt: "2026-07-23T00:00:00.000Z",
        metadata: {},
      });
      updateJsonColumn(
        path,
        "messages",
        "metadata_json",
        "message-invalid-metadata",
        "null",
      );

      expectDatabaseRecordError(
        () => database.messages.listRecent("session-1", 1),
        "messages",
        "message-invalid-metadata",
      );
    });
  });

  it("wraps valid JSON with invalid memory and event-run shapes", async () => {
    await withCorruptedDatabase(async (database, path) => {
      database.memories.insert({
        id: "memory-invalid-metadata",
        sessionId: "session-1",
        content: "remember",
        occurredAt: "2026-07-23T00:00:00.000Z",
        metadata: {},
      });
      updateJsonColumn(
        path,
        "memories",
        "metadata_json",
        "memory-invalid-metadata",
        "null",
      );

      expectDatabaseRecordError(
        () => database.memories.listRecent("session-1", 1),
        "memories",
        "memory-invalid-metadata",
      );

      const eventRun: EventRun = {
        id: "event-run-invalid-error",
        traceId: "trace-invalid-error",
        workflowId: "workflow-1",
        nodeId: "node-1",
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:00.010Z",
        status: "failed",
        retryable: false,
        error: { name: "Error", message: "failed" },
      };
      await database.eventRuns.record(eventRun);
      updateJsonColumn(path, "event_runs", "error_json", eventRun.id, "{}");

      expectDatabaseRecordError(
        () => database.eventRuns.listByTrace(eventRun.traceId),
        "event_runs",
        eventRun.id,
      );
    });
  });

  it("wraps valid JSON with invalid LLM prompt and error shapes", async () => {
    await withCorruptedDatabase(async (database, path) => {
      const promptTrace: LlmTrace = {
        id: "llm-trace-invalid-prompt",
        traceId: "trace-invalid-prompt",
        workflowId: "workflow-1",
        nodeId: "node-1",
        kind: "reply",
        modelId: "model-1",
        prompt,
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:00.010Z",
        durationMs: 10,
        status: "completed",
        response: { text: "hello" },
      };
      const errorTrace: LlmTrace = {
        ...promptTrace,
        id: "llm-trace-invalid-error",
        traceId: "trace-invalid-error",
        status: "failed",
        error: {
          name: "KaguyaLlmError",
          message: "provider unavailable",
          kind: "retryable",
        },
      };
      await database.llmTraces.write(promptTrace);
      await database.llmTraces.write(errorTrace);
      updateJsonColumn(path, "llm_traces", "prompt_json", promptTrace.id, "{}");
      updateJsonColumn(path, "llm_traces", "error_json", errorTrace.id, "{}");

      expectDatabaseRecordError(
        () => database.llmTraces.listByTrace(promptTrace.traceId),
        "llm_traces",
        promptTrace.id,
      );
      expectDatabaseRecordError(
        () => database.llmTraces.listByTrace(errorTrace.traceId),
        "llm_traces",
        errorTrace.id,
      );
    });
  });
});

describe("scoped demo cleanup", () => {
  it("deletes only requested session and trace records", async () =>
    withDatabase(async (database) => {
      const demoMessage: MessageRecord = {
        id: "message-demo",
        sessionId: "demo-session",
        role: "user",
        content: "demo",
        occurredAt: "2026-07-23T00:00:00.000Z",
        metadata: { traceId: "trace-demo" },
      };
      const unrelatedMessage: MessageRecord = {
        ...demoMessage,
        id: "message-unrelated",
        sessionId: "unrelated-session",
        content: "keep",
        metadata: { traceId: "trace-unrelated" },
      };
      const demoMemory: MemoryRecord = {
        id: "memory-demo",
        sessionId: "demo-session",
        content: "demo state",
        occurredAt: "2026-07-23T00:00:00.000Z",
        metadata: { traceId: "trace-demo" },
      };
      const unrelatedMemory: MemoryRecord = {
        ...demoMemory,
        id: "memory-unrelated",
        sessionId: "unrelated-session",
        content: "keep state",
        metadata: { traceId: "trace-unrelated" },
      };
      const demoRun: EventRun = {
        id: "event-run-demo",
        traceId: "trace-demo",
        workflowId: "demo-workflow",
        nodeId: "demo-node",
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:00.001Z",
        status: "completed",
        output: { ok: true },
      };
      const unrelatedRun: EventRun = {
        ...demoRun,
        id: "event-run-unrelated",
        traceId: "trace-unrelated",
      };
      const demoTrace: LlmTrace = {
        id: "llm-trace-demo",
        traceId: "trace-demo",
        workflowId: "demo-workflow",
        nodeId: "demo-node",
        kind: "reply",
        modelId: "demo-model",
        prompt,
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:00.001Z",
        durationMs: 1,
        status: "completed",
        response: { text: "demo" },
      };
      const unrelatedTrace: LlmTrace = {
        ...demoTrace,
        id: "llm-trace-unrelated",
        traceId: "trace-unrelated",
        response: { text: "keep" },
      };

      database.messages.insert(demoMessage);
      database.messages.insert(unrelatedMessage);
      database.memories.insert(demoMemory);
      database.memories.insert(unrelatedMemory);
      await database.eventRuns.record(demoRun);
      await database.eventRuns.record(unrelatedRun);
      await database.llmTraces.write(demoTrace);
      await database.llmTraces.write(unrelatedTrace);

      database.eventRuns.deleteByTraceIds([]);
      database.llmTraces.deleteByTraceIds([]);
      expect(database.eventRuns.listByTrace("trace-demo")).toEqual([demoRun]);
      expect(database.llmTraces.listByTrace("trace-demo")).toEqual([demoTrace]);

      database.messages.deleteBySession("demo-session");
      database.memories.deleteBySession("demo-session");
      database.eventRuns.deleteByTraceIds(["trace-demo"]);
      database.llmTraces.deleteByTraceIds(["trace-demo"]);

      expect(database.messages.listRecent("demo-session", 10)).toEqual([]);
      expect(database.memories.listRecent("demo-session", 10)).toEqual([]);
      expect(database.eventRuns.listByTrace("trace-demo")).toEqual([]);
      expect(database.llmTraces.listByTrace("trace-demo")).toEqual([]);
      expect(database.messages.listRecent("unrelated-session", 10)).toEqual([
        unrelatedMessage,
      ]);
      expect(database.memories.listRecent("unrelated-session", 10)).toEqual([
        unrelatedMemory,
      ]);
      expect(database.eventRuns.listByTrace("trace-unrelated")).toEqual([
        unrelatedRun,
      ]);
      expect(database.llmTraces.listByTrace("trace-unrelated")).toEqual([
        unrelatedTrace,
      ]);
    }));
});

function withCorruptedDatabase(
  callback: (database: KaguyaDatabase, path: string) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "kaguya-database-"));
  const path = join(directory, "kaguya.sqlite");
  const database = KaguyaDatabase.open(path);
  database.migrate();

  return Promise.resolve(callback(database, path)).finally(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

function updateJsonColumn(
  path: string,
  table: "event_runs" | "messages" | "memories" | "llm_traces",
  column: "metadata_json" | "prompt_json" | "error_json",
  id: string,
  value: string,
): void {
  const sqlite = new DatabaseSync(path);
  sqlite
    .prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
    .run(value, id);
  sqlite.close();
}

function expectDatabaseRecordError(
  read: () => unknown,
  table: string,
  recordId: string,
): void {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseRecordError);
    expect(error).toMatchObject({ table, recordId });
    expect((error as Error).cause).toBeInstanceOf(Error);
    return;
  }
  throw new Error("Expected a DatabaseRecordError");
}
