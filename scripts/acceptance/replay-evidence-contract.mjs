/**
 * 功能概述：定义 W11 六组重放证据的完整性契约，避免空数组或省略字段通过验收。
 * 主要职责：replayAssertions 列出各组真实测试发布的断言；validateReplayEvidenceContract
 * 核对执行前后的源码身份、完整断言、资源清理和用量边界；validateReplayEvidenceBatch
 * 要求所选后端恰好各有六组完整记录，最终验收同时核对当前工作树和记录均干净。
 * validateReplayScenarioOutcome 检查独立 effect 与持久终态，成功工具调用必须指向同一回执及最终 run。
 * 代码库关系：check-replay-evidence.mjs 在读取文件后调用；replay-fixture.ts 生产证据，
 * test-replay-evidence-contract.mjs 使用合成清单验证失败边界，不启动数据库、模型或 MCP。
 * 输入输出与副作用：接收清单及预期 backend/group；只作同步校验，不读取文件或运行命令。
 */
import assert from "node:assert/strict";

export const replayAssertions = {
  quiet: ["D4.quiet-formation", "D8.scope-speaker-adapter-isolation"],
  late: [
    "D8.late33-cross-page",
    "D4.immutable-freeze",
    "D8.restart-no-model-replay",
  ],
  holes: [
    "D4.formation-failure-successor",
    "D8.independent-watermarks-no-gap-jump",
  ],
  withdraw: [
    "D6.withdraw-before-admission-zero-effect",
    "D5.withdrawn-source-redaction",
  ],
  success: [
    "D6.real-stdio-success-effect-once",
    "D8.success-restart-no-reexecution",
    "D5.success-paired-run-inspection",
  ],
  unknown: [
    "D6.real-stdio-effect-once",
    "D8.unknown-late-restart-workers",
    "D5.scoped-action-inspection",
  ],
};

const sourcePaths = [
  "apps/server/src/test-support/replay-fixture.ts",
  "apps/server/src/issue279-replay.test.ts",
];
// evidence manifest write 尚未结束时便已复制 phases，因此不能要求其自证完成。
const cleanupPhases = [
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
];
const sha256 = /^[a-f0-9]{64}$/;

export function validateReplayEvidenceContract(record, { backend, group }) {
  const label = `${backend}/${group}`;
  assert(["PGlite", "PostgreSQL"].includes(backend), "unknown backend");
  assert(Object.hasOwn(replayAssertions, group), "unknown replay group");
  assert.equal(record.backend, backend, `${label}: wrong backend`);
  assert.equal(record.passed, true, `${label}: test did not pass`);
  assert.equal(
    typeof record.dirty,
    "boolean",
    `${label}: missing source state`,
  );
  assert(Array.isArray(record.assertions), `${label}: assertions missing`);
  assert.deepEqual(
    [...record.assertions].sort(),
    [...replayAssertions[group]].sort(),
    `${label}: assertions must identify exactly one complete scenario`,
  );

  assert(record.sourceHashes && typeof record.sourceHashes === "object");
  for (const path of sourcePaths)
    assert(
      typeof record.sourceHashes[path] === "string" &&
        sha256.test(record.sourceHashes[path]),
      `${label}: missing or invalid source hash ${path}`,
    );
  const before = record.sourceState?.before;
  const after = record.sourceState?.after;
  assert(before && after, `${label}: execution source snapshots missing`);
  assert.equal(typeof before.dirty, "boolean");
  assert.equal(typeof after.dirty, "boolean");
  assert.equal(
    before.headSha,
    record.headSha,
    `${label}: HEAD changed during execution`,
  );
  assert.equal(after.headSha, record.headSha, `${label}: final HEAD mismatch`);
  assert.deepEqual(
    before.sourceHashes,
    record.sourceHashes,
    `${label}: sources changed during execution`,
  );
  assert.deepEqual(
    after.sourceHashes,
    record.sourceHashes,
    `${label}: final source hashes mismatch`,
  );
  assert.equal(
    record.dirty,
    before.dirty || after.dirty,
    `${label}: inconsistent source state`,
  );
  assert(sha256.test(record.fixtureSha256), `${label}: invalid scenario hash`);
  assert(
    sha256.test(record.providers?.mcpSourceSha256),
    `${label}: invalid MCP source hash`,
  );

  const cleanup = record.cleanup;
  assert(Array.isArray(cleanup?.phases), `${label}: cleanup phases missing`);
  for (const phase of cleanupPhases)
    assert.equal(
      cleanup.phases.filter(
        (entry) => entry.phase === phase && entry.status === "confirmed",
      ).length,
      1,
      `${label}: cleanup phase not confirmed exactly once: ${phase}`,
    );
  assert.equal(cleanup.modelTasksSettled, true);
  assert.equal(cleanup.directoryRetained, false);
  assert.deepEqual(cleanup.errors, []);

  assert(
    Array.isArray(record.phases) && record.phases.length > 0,
    `${label}: measured phases missing`,
  );
  assert(Number.isSafeInteger(record.calls?.model) && record.calls.model > 0);
  assert(Number.isSafeInteger(record.calls?.tool) && record.calls.tool >= 0);
  const unknown = record.usage?.unknownUsageRequests;
  assert(
    Number.isSafeInteger(unknown) &&
      unknown >= 0 &&
      unknown <= record.calls.model,
    `${label}: unknown usage count inconsistent with requests`,
  );
  for (const key of ["inputTokens", "outputTokens"])
    if (unknown > 0)
      assert.equal(
        record.usage[key],
        null,
        `${label}: unknown ${key} became known`,
      );
    else
      assert(
        Number.isSafeInteger(record.usage[key]) && record.usage[key] >= 0,
        `${label}: missing known ${key}`,
      );
}

/** 将完整批次映射到唯一场景；失败残留不能被有效记录遮蔽，单后端验收必须显式选定。 */
export function validateReplayEvidenceBatch(
  records,
  { backends = ["PGlite", "PostgreSQL"], headSha, dirty, allowDirty = false },
) {
  assert(Array.isArray(records), "evidence batch must be an array");
  assert(
    typeof headSha === "string" && /^[a-f0-9]{40}$/.test(headSha),
    "invalid current HEAD",
  );
  assert.equal(typeof dirty, "boolean", "current source state missing");
  assert(
    allowDirty || !dirty,
    "current dirty sources are development evidence",
  );
  assert(backends.length > 0 && new Set(backends).size === backends.length);
  for (const backend of backends)
    assert(["PGlite", "PostgreSQL"].includes(backend), "unknown backend");
  for (const record of records)
    assert(
      ["PGlite", "PostgreSQL"].includes(record?.backend),
      "evidence backend missing or invalid",
    );
  const cases = [];
  for (const backend of backends) {
    const selected = records.filter((record) => record.backend === backend);
    assert.equal(
      selected.length,
      Object.keys(replayAssertions).length,
      `${backend}: exactly one record per scenario required; remove stale or incomplete evidence`,
    );
    for (const [group, ids] of Object.entries(replayAssertions)) {
      const matches = selected.filter(
        (record) =>
          Array.isArray(record.assertions) &&
          record.assertions.includes(ids[0]),
      );
      assert.equal(
        matches.length,
        1,
        `${backend}/${group}: exactly one complete case required`,
      );
      const record = matches[0];
      validateReplayEvidenceContract(record, { backend, group });
      assert.equal(record.schemaVersion, 1);
      assert.equal(record.headSha, headSha, `${backend}/${group}: stale SHA`);
      assert(
        allowDirty || !record.dirty,
        `${backend}/${group}: dirty source is development evidence`,
      );
      cases.push({ backend, group, record });
    }
  }
  return cases;
}

/** 核对场景实际结果：不把存在任意一条结果记录等同于目标行动已成功。 */
export function validateReplayScenarioOutcome(record, group) {
  const effects = record.oracle.filter((entry) => entry.kind === "effect");
  assert.equal(
    record.calls.tool,
    effects.length,
    "tool effect count does not match independent journal",
  );
  if (["quiet", "withdraw"].includes(group)) assert.equal(effects.length, 0);
  if (!["success", "unknown"].includes(group)) return;
  assert.equal(
    effects.length,
    1,
    `${group}: exactly one independent MCP effect required`,
  );
  const actions = record.persisted.actions.filter(
    (action) => action.input.providerId === "mcp.weather",
  );
  assert.equal(actions.length, 1, `${group}: exactly one MCP action required`);
  const facts = record.persisted.facts;
  if (group === "unknown") {
    assert.equal(actions[0].state, "unknown");
    assert(facts.some((fact) => fact.kind === "mcp.client.late-result.v1"));
    return;
  }
  const action = actions[0];
  assert.equal(action.state, "succeeded");
  assert(
    typeof action.receipt_id === "string" && action.receipt_id.length > 0,
    "success: original action receipt missing",
  );
  const result = facts.filter(
    (fact) =>
      fact.kind === "agent.heavy.tool.result.v1" &&
      fact.payload.intentId === action.intent_id &&
      fact.payload.receiptId === action.receipt_id,
  );
  assert.equal(
    result.length,
    1,
    "success: native result must bind the original action and receipt",
  );
  assert(
    facts.some(
      (fact) =>
        fact.kind === "core.action.result.v1" &&
        fact.informationId === action.receipt_id,
    ),
    "success: original action receipt fact missing",
  );
  const terminal = facts.filter(
    (fact) =>
      fact.kind === "agent.heavy.tool.terminal.v1" &&
      fact.payload.runInformationId === result[0].payload.runInformationId,
  );
  assert.equal(
    terminal.length,
    1,
    "success: exactly one terminal for the paired native run required",
  );
  assert.equal(
    terminal[0].payload.reason,
    "final",
    "success: native run did not reach its final reply",
  );
  for (const kind of ["core.message.assistant.text", "core.delivery.delivered"])
    assert.equal(
      facts.filter((fact) => fact.kind === kind).length,
      1,
      `success: exactly one ${kind} required`,
    );
  assert.equal(
    facts.filter((fact) => fact.kind === "core.delivery.failed").length,
    0,
    "success: failed final delivery",
  );
}
