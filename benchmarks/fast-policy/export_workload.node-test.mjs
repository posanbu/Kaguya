/**
 * 功能概述：验证 benchmark 导出器的时间、结果泄漏和私有文件边界。
 * .node-test.mjs 命名标明本文件由 node --test 显式执行，避免被根 Vitest 的 .test 模式误收集。
 * 主要职责：使用虚构账本行测试 freezeRequests，不连接数据库；文件测试只在随机
 * 临时目录内检查 0600 和拒绝覆盖。import 不应触发配置读取或生产导出。
 * 代码库关系：直接测试 export_workload.mjs 暴露的纯转换与 I/O 函数；由 node --test
 * 和独立 benchmark CI 执行，无真实 API key、数据库凭据或消息正文。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  freezeRequests,
  parseArguments,
  writePrivateFile,
} from "./export_workload.mjs";

function request() {
  return {
    information_id: "request-test-only",
    occurred_at: "2026-01-02T00:00:00Z",
    payload: {
      taskId: "agent.turn.plan",
      contextInformationIds: [
        "old-b",
        "future",
        "terminal",
        "missing",
        "old-a",
      ],
      prompt: { text: "test-only frozen prompt", variables: [] },
      resolvedModel: {
        modelId: "test-model",
        providerId: "test-provider",
        apiKey: "test-only-placeholder",
      },
      output: "MUST_NOT_EXPORT_OLD_RESULT",
    },
  };
}

test("frozen context preserves declared order, excludes future and results, counts missing", () => {
  const contexts = new Map([
    [
      "old-a",
      {
        information_id: "old-a",
        kind: "inbound.text",
        occurred_at: "2026-01-01T00:00:00Z",
        payload: { text: "test-only a" },
      },
    ],
    [
      "old-b",
      {
        information_id: "old-b",
        kind: "inbound.text",
        occurred_at: "2026-01-01T01:00:00Z",
        payload: { text: "test-only b" },
      },
    ],
    [
      "future",
      {
        information_id: "future",
        kind: "inbound.text",
        occurred_at: "2026-01-03T00:00:00Z",
        payload: { text: "FUTURE_SECRET" },
      },
    ],
    [
      "terminal",
      {
        information_id: "terminal",
        kind: "core.model.task.completed",
        occurred_at: "2026-01-01T00:00:00Z",
        payload: { output: "OLD_RESULT" },
      },
    ],
  ]);
  const output = freezeRequests([request()], contexts, new Map());
  assert.deepEqual(
    output.records[0].context_atoms.map((x) => x.informationId),
    ["old-b", "old-a"],
  );
  assert.equal(output.missingContextCount, 1);
  assert.equal(output.futureContextCount, 1);
  assert.equal(output.excludedContextCount, 1);
  assert.equal(output.records[0].request_meta.modelId, "test-model");
  assert.equal(output.records[0].prompt.text, "test-only frozen prompt");
  assert.doesNotMatch(
    JSON.stringify(output),
    /FUTURE_SECRET|OLD_RESULT|test-only-placeholder|apiKey/,
  );
});

test("CLI rejects unknown or missing arguments", () => {
  assert.throws(() => parseArguments(["--output"]));
  assert.throws(() => parseArguments(["--unknown", "x"]));
  assert.ok(path.isAbsolute(parseArguments([]).configRoot));
});

test("private output is created without overwrite", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "kaguya-export-test-"),
  );
  const filename = path.join(folder, "private.jsonl");
  try {
    await writePrivateFile(filename, "test-only-original");
    if (process.platform !== "win32")
      assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateFile(filename, "overwrite"), {
      code: "EEXIST",
    });
    assert.equal(await fs.readFile(filename, "utf8"), "test-only-original");
  } finally {
    await fs.unlink(filename);
    await fs.rmdir(folder);
  }
});
