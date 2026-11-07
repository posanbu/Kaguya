/**
 * 功能概述：以纯内存合成数据回归回复节奏协议、参考隔离和人工复核绑定。
 * 主要职责：检查独立缺陷计数、待复核/失败分母、候选输入绑定、陈旧复核拒绝及未来输入/引用/媒体边界。
 * 代码库关系：Vitest 运行 protocol.cjs；生产 Prompt 集成由 promptfoo/reply-rhythm-provider.test.ts 验证。
 * 输入输出与副作用：仅加载同目录公开合成 JSON，无网络、计时器、数据库或持久化写入。
 */
import { createRequire } from "node:module";
import { test } from "vitest";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const {
  candidateInput,
  validateCase,
  score,
  reviewTemplate,
  digest,
} = require("./protocol.cjs");
const cases = require("./cases.json");
const candidates = require("./baseline-candidates.json");
const reviews = require("./baseline-reviews.json");
const clone = (value) => JSON.parse(JSON.stringify(value));
test("authored baseline separates omitted answers and extra actions without human claims", () => {
  const report = score(cases, candidates, reviews);
  assert.equal(report.candidates, 12);
  assert.equal(report.reviewed, 12);
  assert.equal(report.authoredFixtureReviewed, 12);
  assert.equal(report.humanReviewed, 0);
  assert.equal(report.missedExplicitQuestion, 3);
  assert.equal(report.unnecessaryExtraAction, 6);
  assert.deepEqual(report.unrepresentedCaseIds, []);
  assert.equal(
    digest(report),
    digest(score(clone(cases), clone(candidates), clone(reviews))),
  );
});
test("candidate input excludes reference replies, requirements and provenance", () => {
  const item = clone(cases[0]);
  item.reference.text = "PRIVATE_REFERENCE_SENTINEL";
  item.requiredAnswers[0].description = "EXPECTED_ANSWER_SENTINEL";
  item.provenance.selectionNote = "SELECTION_SENTINEL";
  const input = JSON.stringify(candidateInput(item));
  for (const marker of [
    "PRIVATE_REFERENCE_SENTINEL",
    "EXPECTED_ANSWER_SENTINEL",
    "SELECTION_SENTINEL",
  ])
    assert.ok(!input.includes(marker));
});
test("pending reviews, errors, timeouts and silence remain visible", () => {
  const outputs = [
    { ...candidates[0], id: "pending" },
    { ...candidates[0], id: "error", status: "error" },
    { ...candidates[0], id: "timeout", status: "timeout" },
    { ...candidates[0], id: "silent", text: "" },
  ];
  const pending = reviewTemplate(cases[0], outputs[0]);
  const report = score(cases, outputs, [pending]);
  assert.equal(report.candidates, 4);
  assert.equal(report.pendingReview, 2);
  assert.equal(report.errors, 1);
  assert.equal(report.timeouts, 1);
  assert.equal(report.reviewed, 0);
  assert.equal(report.unrepresentedCaseIds.length, 5);
});
test("edited candidate or case invalidates its prior review", () => {
  const output = clone(candidates[0]);
  output.text += " altered";
  assert.throws(() => score(cases, [output], [reviews[0]]), /stale review/);
  const changedCases = clone(cases);
  changedCases[0].requiredAnswers[0].description += " altered";
  assert.throws(
    () => score(changedCases, [candidates[0]], [reviews[0]]),
    /stale review/,
  );
});
test("reviews assess all explicit questions and cite actual extra text", () => {
  const incomplete = clone(reviews[0]);
  incomplete.answers = [];
  assert.throws(
    () => score(cases, [candidates[0]], [incomplete]),
    /every required answer/,
  );
  const fabricated = clone(reviews[1]);
  fabricated.extraActions[0].excerpt = "NOT_IN_OUTPUT";
  assert.throws(() => score(cases, [candidates[1]], [fabricated]), /excerpt/);
});
test("unknown semantic outcomes remain uncertain", () => {
  const review = clone(reviews[0]);
  review.answers[0].status = "uncertain";
  review.extraActionsAssessment = "uncertain";
  const report = score(cases, [candidates[0]], [review]);
  assert.equal(report.uncertain, 1);
  assert.equal(report.missedExplicitQuestion, 0);
});
test("rejects future inputs, automatic links, unknown reply targets and hidden media", () => {
  for (const [edit, pattern] of [
    [
      (item) => {
        item.input.messages[0].receivedAt = "2030-01-01T00:00:00Z";
      },
      /cutoff prefix/,
    ],
    [
      (item) => {
        item.reference.association = "adjacent";
      },
      /manual/,
    ],
    [
      (item) => {
        item.input.messages[0].replyTo = "future";
      },
      /earlier visible/,
    ],
    [
      (item) => {
        item.input.messages[0].mediaTypes = ["image"];
      },
      /marked missing/,
    ],
    [
      (item) => {
        item.input.messages[0].sender = "123456789";
      },
      /pseudonymous/,
    ],
    [
      (item) => {
        item.dataKind = "anonymized";
      },
      /privacy review/,
    ],
  ]) {
    const item = clone(cases[0]);
    edit(item);
    assert.throws(() => validateCase(item), pattern);
  }
});

test("rejects stale visible inputs for success, errors and timeouts before re-review", () => {
  const changedCases = clone(cases);
  changedCases[0].input.messages[0].text = "活动通知：四点开始。";
  for (const status of ["ok", "error", "timeout"]) {
    const candidate = { ...candidates[0], status };
    assert.throws(
      () => score(changedCases, [candidate], []),
      /candidate input hash mismatch/,
    );
    assert.throws(
      () => reviewTemplate(changedCases[0], candidate),
      /candidate input hash mismatch/,
    );
    const missingHash = { ...candidate };
    delete missingHash.inputSha256;
    assert.throws(
      () => score(cases, [missingHash], []),
      /candidate input hash mismatch/,
    );
  }
});
test("rubric-only edits allow fresh review without pretending that the input changed", () => {
  const changedCases = clone(cases);
  changedCases[0].requiredAnswers[0].description += " 请用语义判断。";
  const fresh = reviewTemplate(changedCases[0], candidates[0]);
  assert.notEqual(fresh.caseSha256, reviews[0].caseSha256);
  assert.equal(fresh.candidateSha256, reviews[0].candidateSha256);
  const report = score(changedCases, [candidates[0]], [fresh]);
  assert.equal(report.pendingReview, 1);
  assert.equal(report.results[0].inputSha256, candidates[0].inputSha256);
});
test("failed candidates retain attribution and cannot carry a semantic assessment", () => {
  const failed = { ...candidates[0], status: "error" };
  assert.throws(() => reviewTemplate(cases[0], failed), /failed candidates/);
  const staleSemanticReview = {
    ...reviews[0],
    candidateSha256: digest(failed),
  };
  assert.throws(
    () => score(cases, [failed], [staleSemanticReview]),
    /failed candidates/,
  );
  const report = score(cases, [failed], []);
  assert.equal(report.errors, 1);
  assert.equal(report.reviewed, 0);
  assert.equal(report.uncertain, 0);
  assert.equal(report.results[0].caseId, failed.caseId);
  assert.equal(report.results[0].variant, failed.variant);
  assert.equal(report.results[0].inputSha256, failed.inputSha256);
});
