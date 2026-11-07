/**
 * 功能概述：用合成证据清单验证验收器拒绝缺少来源、部分完成、清理未结束和未知用量伪装。
 * 主要职责：completeEvidence 提供与 replay-fixture 输出同形的最小完整性输入；测试只改变
 * 与验收结论有关的字段，确认六组完整声明均被接受而证据被删减时失败。
 * 代码库关系：直接导入 replay-evidence-contract，不运行 Vitest、数据库、Git、模型或 MCP。
 * 输入输出与副作用：通过 node --test 执行，全部数据在内存中生成，不修改共享工作区。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  replayAssertions,
  validateReplayEvidenceContract,
  validateReplayEvidenceBatch,
  validateReplayScenarioOutcome,
} from "./replay-evidence-contract.mjs";

function completeEvidence(group = "unknown", backend = "PostgreSQL") {
  const record = {
    schemaVersion: 1,
    headSha: "e".repeat(40),
    backend,
    passed: true,
    dirty: false,
    assertions: [...replayAssertions[group]],
    sourceHashes: {
      "apps/server/src/test-support/replay-fixture.ts": "a".repeat(64),
      "apps/server/src/issue279-replay.test.ts": "b".repeat(64),
    },
    fixtureSha256: "c".repeat(64),
    providers: { mcpSourceSha256: "d".repeat(64) },
    cleanup: {
      phases: [
        "release actual MCP test barriers",
        "Server close",
        "Runtime owner close",
        "independent MCP owners close",
        "model HTTP observers settle",
        "read-only evidence snapshot",
        "MCP journal read",
        "SQL connection close",
        "PostgreSQL schema cleanup",
        "fixture directory removal",
      ].map((phase) => ({ phase, status: "confirmed" })),
      modelTasksSettled: true,
      directoryRetained: false,
      errors: [],
    },
    phases: [{ phase: "settled", durationMs: 1 }],
    calls: { model: 3, tool: group === "unknown" ? 1 : 0 },
    usage: { unknownUsageRequests: 0, inputTokens: 3, outputTokens: 3 },
  };
  const snapshot = {
    headSha: record.headSha,
    dirty: record.dirty,
    sourceHashes: record.sourceHashes,
  };
  record.sourceState = {
    before: structuredClone(snapshot),
    after: structuredClone(snapshot),
  };
  return record;
}
const validate = (record) =>
  validateReplayEvidenceContract(record, {
    backend: "PostgreSQL",
    group: "unknown",
  });

test("accepts complete claims for all six groups on each backend", () => {
  for (const backend of ["PGlite", "PostgreSQL"])
    for (const group of Object.keys(replayAssertions))
      assert.doesNotThrow(() =>
        validateReplayEvidenceContract(completeEvidence(group, backend), {
          backend,
          group,
        }),
      );
});

for (const [name, corrupt] of [
  [
    "empty source hashes",
    (r) => {
      r.sourceHashes = {};
    },
  ],
  [
    "missing fixture hash",
    (r) => {
      delete r.sourceHashes["apps/server/src/test-support/replay-fixture.ts"];
    },
  ],
  [
    "invalid source hash",
    (r) => {
      r.sourceHashes["apps/server/src/issue279-replay.test.ts"] = "unverified";
    },
  ],
  [
    "only the anchor assertion",
    (r) => {
      r.assertions = [r.assertions[0]];
    },
  ],
  [
    "empty cleanup phases",
    (r) => {
      r.cleanup.phases = [];
    },
  ],
  [
    "missing SQL cleanup",
    (r) => {
      r.cleanup.phases = r.cleanup.phases.filter(
        (p) => p.phase !== "SQL connection close",
      );
    },
  ],
  [
    "unconfirmed PostgreSQL cleanup",
    (r) => {
      r.cleanup.phases.find(
        (p) => p.phase === "PostgreSQL schema cleanup",
      ).status = "unconfirmed";
    },
  ],
  [
    "unfinished model work",
    (r) => {
      r.cleanup.modelTasksSettled = false;
    },
  ],
  [
    "absent source state",
    (r) => {
      delete r.dirty;
    },
  ],
  [
    "unknown output usage counted as known",
    (r) => {
      r.usage.unknownUsageRequests = 1;
      r.usage.inputTokens = null;
    },
  ],
  [
    "impossible unknown request count",
    (r) => {
      r.usage.unknownUsageRequests = 4;
    },
  ],
  [
    "missing phase measurements",
    (r) => {
      r.phases = [];
    },
  ],
  [
    "missing scenario identity",
    (r) => {
      delete r.fixtureSha256;
    },
  ],
  [
    "missing MCP source identity",
    (r) => {
      delete r.providers.mcpSourceSha256;
    },
  ],
])
  test(`rejects ${name}`, () => {
    const record = completeEvidence();
    corrupt(record);
    assert.throws(() => validate(record), assert.AssertionError);
  });

test("accepts explicit unknown token totals after a failed request", () => {
  const record = completeEvidence();
  record.usage = {
    unknownUsageRequests: 1,
    inputTokens: null,
    outputTokens: null,
  };
  assert.doesNotThrow(() => validate(record));
});

// 一个清单不能同时充当多个场景，也不能用重复 ID 填充完整声明。
test("rejects a record that claims several replay groups", () => {
  const record = completeEvidence("quiet");
  record.assertions.push(...replayAssertions.late, ...replayAssertions.holes);
  assert.throws(
    () =>
      validateReplayEvidenceContract(record, {
        backend: "PostgreSQL",
        group: "quiet",
      }),
    assert.AssertionError,
  );
});
test("rejects duplicate assertion identities", () => {
  const record = completeEvidence();
  record.assertions.push(record.assertions[0]);
  assert.throws(() => validate(record), assert.AssertionError);
});

const batchOptions = { headSha: "e".repeat(40), dirty: false };
const completeBatch = () =>
  ["PGlite", "PostgreSQL"].flatMap((backend) =>
    Object.keys(replayAssertions).map((group) =>
      completeEvidence(group, backend),
    ),
  );
test("accepts one completed case per scenario and backend", () => {
  assert.equal(
    validateReplayEvidenceBatch(completeBatch(), batchOptions).length,
    12,
  );
});
test("rejects a successful batch that also contains an incomplete attempt", () => {
  const records = completeBatch();
  records.push({ ...completeEvidence(), passed: false, assertions: [] });
  assert.throws(
    () => validateReplayEvidenceBatch(records, batchOptions),
    /exactly one record per scenario/,
  );
});
test("rejects one missing scenario despite an equal record count", () => {
  const records = completeBatch();
  records[0].assertions = [];
  assert.throws(
    () => validateReplayEvidenceBatch(records, batchOptions),
    /exactly one complete case/,
  );
});
test("rejects the historical five-case suite without successful Heavy continuation", () => {
  const records = completeBatch().filter(
    (record) =>
      !record.assertions.includes("D6.real-stdio-success-effect-once"),
  );
  assert.throws(
    () => validateReplayEvidenceBatch(records, batchOptions),
    /exactly one record per scenario/,
  );
});
test("rejects old clean evidence when the current source is dirty", () => {
  assert.throws(
    () =>
      validateReplayEvidenceBatch(completeBatch(), {
        ...batchOptions,
        dirty: true,
      }),
    /current dirty sources/,
  );
});
test("rejects recorded dirty evidence even after the working tree becomes clean", () => {
  const records = completeBatch();
  records[0].dirty = true;
  records[0].sourceState.before.dirty = true;
  assert.throws(
    () => validateReplayEvidenceBatch(records, batchOptions),
    /dirty source is development evidence/,
  );
});
test("accepts unchanged development source only with the explicit override", () => {
  const records = completeBatch();
  records[0].dirty = true;
  records[0].sourceState.before.dirty = true;
  assert.equal(
    validateReplayEvidenceBatch(records, {
      ...batchOptions,
      dirty: true,
      allowDirty: true,
    }).length,
    12,
  );
});
test("rejects missing before/after source provenance", () => {
  const record = completeEvidence();
  delete record.sourceState;
  assert.throws(() => validate(record), /execution source snapshots missing/);
});
test("rejects source changes during a development replay", () => {
  const records = completeBatch();
  records[0].sourceState.before.sourceHashes[
    "apps/server/src/test-support/replay-fixture.ts"
  ] = "f".repeat(64);
  assert.throws(
    () =>
      validateReplayEvidenceBatch(records, {
        ...batchOptions,
        allowDirty: true,
      }),
    /sources changed during execution/,
  );
});
test("rejects a commit change during replay", () => {
  const record = completeEvidence();
  record.sourceState.before.headSha = "f".repeat(40);
  assert.throws(() => validate(record), /HEAD changed during execution/);
});
test("rejects an earlier commit even when every record agrees on it", () => {
  assert.throws(
    () =>
      validateReplayEvidenceBatch(completeBatch(), {
        ...batchOptions,
        headSha: "f".repeat(40),
      }),
    /stale SHA/,
  );
});
test("requires the other backend unless a subset is explicitly selected", () => {
  const records = completeBatch().filter(
    (record) => record.backend === "PostgreSQL",
  );
  assert.throws(
    () => validateReplayEvidenceBatch(records, batchOptions),
    /PGlite: exactly one record/,
  );
  assert.equal(
    validateReplayEvidenceBatch(records, {
      ...batchOptions,
      backends: ["PostgreSQL"],
    }).length,
    6,
  );
});

function completedToolOutcome() {
  return {
    calls: { tool: 1 },
    oracle: [{ kind: "effect" }],
    persisted: {
      actions: [
        {
          input: { providerId: "mcp.weather" },
          state: "succeeded",
          intent_id: "intent",
          receipt_id: "receipt",
        },
      ],
      facts: [
        { kind: "core.action.result.v1", informationId: "receipt" },
        {
          kind: "agent.heavy.tool.result.v1",
          payload: {
            intentId: "intent",
            receiptId: "receipt",
            runInformationId: "run",
          },
        },
        {
          kind: "agent.heavy.tool.terminal.v1",
          payload: { runInformationId: "run", reason: "final" },
        },
        { kind: "core.message.assistant.text" },
        { kind: "core.delivery.delivered" },
      ],
    },
  };
}
test("accepts the successful MCP result paired with its original receipt and final run", () => {
  assert.doesNotThrow(() =>
    validateReplayScenarioOutcome(completedToolOutcome(), "success"),
  );
});
for (const [name, corrupt] of [
  [
    "a receipt from another action",
    (r) => {
      r.persisted.facts[1].payload.receiptId = "other";
    },
  ],
  [
    "a final terminal from another run",
    (r) => {
      r.persisted.facts[2].payload.runInformationId = "other";
    },
  ],
  [
    "an unknown tool stop relabeled as success",
    (r) => {
      r.persisted.facts[2].payload.reason = "unknown";
    },
  ],
  [
    "an undelivered final response",
    (r) => {
      r.persisted.facts.pop();
    },
  ],
  [
    "a duplicate external effect",
    (r) => {
      r.oracle.push({ kind: "effect" });
      r.calls.tool = 2;
    },
  ],
])
  test(`rejects successful evidence with ${name}`, () => {
    const record = completedToolOutcome();
    corrupt(record);
    assert.throws(
      () => validateReplayScenarioOutcome(record, "success"),
      assert.AssertionError,
    );
  });
