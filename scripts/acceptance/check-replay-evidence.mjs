#!/usr/bin/env node
/**
 * 功能概述：检查W11双数据库真实writer重放证据，拒绝缺组、旧SHA、脏工作树或未完成清理。
 * 主要职责：按完整 assertion 集合要求六组各一次，核对真实 producer、必需源码哈希、清理阶段和独立 MCP effect。
 * 代码库关系：issue279-replay.test.ts通过KAGUYA_REPLAY_EVIDENCE_DIR输出JSON；本入口只读校验并打印摘要。
 * 输入输出与副作用：参数为独立证据目录；--allow-dirty仅用于开发，--backend可明确核对单后端，
 * 两者均在摘要降低验收范围。模型始终标记scripted，物理GUI不被计作已验收，不推算真实费用。
 */
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  validateReplayEvidenceBatch,
  validateReplayScenarioOutcome,
} from "./replay-evidence-contract.mjs";
const args = process.argv.slice(2);
const directory = args.find((a) => !a.startsWith("--"));
assert(
  directory,
  "usage: node scripts/acceptance/check-replay-evidence.mjs DIRECTORY [--allow-dirty] [--backend=PGlite]",
);
const allowDirty = args.includes("--allow-dirty");
const selected = args.find((a) => a.startsWith("--backend="))?.split("=")[1];
assert(
  !selected || ["PGlite", "PostgreSQL"].includes(selected),
  "unknown backend",
);
const backends = selected ? [selected] : ["PGlite", "PostgreSQL"];
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
  timeout: 2000,
}).trim();
const currentDirty = !!execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
  timeout: 2000,
}).trim();
const files = (await readdir(directory)).filter((name) =>
  /^(PGlite|PostgreSQL)-.+\.json$/.test(name),
);
const evidence = await Promise.all(
  files.map(async (name) =>
    JSON.parse(await readFile(`${directory}/${name}`, "utf8")),
  ),
);
const summary = [];
let scenarioDigest;
let mcpSourceDigest;
for (const { backend, group, record: r } of validateReplayEvidenceBatch(
  evidence,
  {
    backends,
    headSha: head,
    dirty: currentDirty,
    allowDirty,
  },
)) {
  assert(
    r.passed &&
      r.cleanup.errors.length === 0 &&
      !r.cleanup.directoryRetained &&
      r.cleanup.modelTasksSettled,
    `${backend}/${group}: result or cleanup incomplete`,
  );
  assert(r.cleanup.phases.every((p) => p.status === "confirmed"));
  assert.equal(r.dataClassification, "synthetic");
  assert.equal(r.providers.model, "scripted-http");
  assert.equal(r.providers.mcp, "actual-stdio-synthetic-service");
  assert.equal(r.usage.source, "synthetic-provider-values");
  assert.equal(r.usage.cost, null);
  assert.equal(r.providers.physicalGui, "not-run");
  assert.equal(r.providers.imageDigest, null);
  scenarioDigest ??= r.fixtureSha256;
  mcpSourceDigest ??= r.providers.mcpSourceSha256;
  assert.equal(
    r.fixtureSha256,
    scenarioDigest,
    "scenario changed between cases",
  );
  assert.equal(
    r.providers.mcpSourceSha256,
    mcpSourceDigest,
    "MCP synthetic service changed between cases",
  );
  assert(
    r.ingress.length >= 8 &&
      r.persisted.facts.length > 0 &&
      r.persisted.observations.length > 0,
  );
  for (const [path, digest] of Object.entries(r.sourceHashes))
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      digest,
      `${path}: source changed since execution`,
    );
  const kinds = new Set(r.persisted.facts.map((f) => f.kind));
  for (const kind of [
    "core.message.inbound.text",
    "memory.identity.person.context.completed",
    "memory.native.source.v1",
    "memory.native.formation.completed.v1",
  ])
    assert(kinds.has(kind), `${backend}/${group}: missing producer ${kind}`);
  for (const inbound of r.ingress) {
    const raw = r.persisted.facts.find(
      (f) => f.informationId === inbound.inboundInformationId,
    );
    assert(
      raw?.references.some(
        (ref) =>
          ref.relation === "core:context" &&
          ref.informationId === inbound.contextInformationId,
      ),
      "ingress context must bind actual inbound",
    );
  }
  assert(Number.isFinite(r.totalDurationMs) && r.totalDurationMs > 0);
  assert(
    r.calls.model > 0 &&
      r.phases.every((p) => Number.isFinite(p.durationMs) && p.durationMs >= 0),
  );
  validateReplayScenarioOutcome(r, group);
  if (r.usage.unknownUsageRequests)
    assert.equal(
      r.usage.inputTokens,
      null,
      "missing usage cannot become zero/known usage",
    );
  summary.push({
    backend,
    group,
    assertionIds: r.assertions,
    modelCalls: r.calls.model,
    toolEffects: r.calls.tool,
    elapsedMs: Math.round(r.totalDurationMs),
  });
}
console.log(
  JSON.stringify(
    {
      headSha: head,
      assurance: selected ? "explicit-backend-subset" : "dual-backend-offline",
      sourceState: allowDirty ? "development" : "clean-commit",
      dirtyAllowed: allowDirty,
      realModelRequests: 0,
      physicalGui: "not-run",
      cases: summary,
    },
    null,
    2,
  ),
);
