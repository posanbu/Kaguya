/**
 * 功能概述：定义回复节奏案例、候选结果及人工复核的离线边界，供 CLI、Promptfoo 和回归共享。
 * 主要职责：validateCase 检查人工关联、匿名身份、观察截点及媒体缺失；candidateInput 只选取可见输入；
 * digest 稳定绑定工件；validateCandidate 将包括错误/超时在内的候选绑定到可见输入；
 * score 按候选核对输入及复核哈希，分别统计漏答和额外行动。
 * 代码库关系：assemble.cjs 将 candidateInput 交给生产编译器；bench.cjs 输出复核模板和报告。
 * 输入输出与副作用：纯内存运算，无网络或文件访问。参考回复/评分要求不能进入候选输入。
 * 未复核、语义不确定、错误及超时保留分母；合成示例标注不冒充人工评审或真人证据。
 */
const { createHash } = require("node:crypto");
const PROTOCOL = "kaguya-reply-rhythm/v1";
const ACTIONS = new Set(["followup", "advice", "topic-extension"]);
const text = (value, label) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be non-empty text`);
};
const unique = (values, label) => {
  if (!Array.isArray(values) || new Set(values).size !== values.length)
    throw new Error(`${label} must be unique`);
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function validateCase(item) {
  if (item.protocol !== PROTOCOL) throw new Error("unsupported case protocol");
  text(item.id, "case id");
  if (!["synthetic", "anonymized"].includes(item.dataKind))
    throw new Error("unsupported data kind");
  if (
    item.dataKind === "anonymized" &&
    item.provenance?.privacyReviewed !== true
  )
    throw new Error("anonymized cases require privacy review");
  text(item.provenance?.selectionNote, "manual selection note");
  if (item.reference?.association !== "manual")
    throw new Error("reply association must be manual");
  text(item.reference.rationale, "association rationale");
  text(item.reference.text, "reference reply");
  if (
    item.reference.kind !==
    (item.dataKind === "synthetic" ? "synthetic-reference" : "human-reply")
  )
    throw new Error("reference provenance mismatch");
  const input = item.input;
  text(input?.persona, "persona");
  const cutoff = Date.parse(input.cutoff);
  if (
    !Number.isFinite(cutoff) ||
    !Array.isArray(input.messages) ||
    !input.messages.length
  )
    throw new Error("invalid visible prefix");
  const seen = new Set();
  let last = -Infinity;
  for (const message of input.messages) {
    text(message.id, "message id");
    if (["intent-1", "turn-1", "raw-1"].includes(message.id))
      throw new Error("reserved fixture identity");
    if (seen.has(message.id) || !/^person-[a-z0-9-]+$/.test(message.sender))
      throw new Error("duplicate message or non-pseudonymous sender");
    const time = Date.parse(message.receivedAt);
    if (!Number.isFinite(time) || time > cutoff || time < last)
      throw new Error("message outside ordered cutoff prefix");
    text(
      message.text,
      "message text (use explicit missing marker for media-only messages)",
    );
    if (
      !Array.isArray(message.mediaTypes) ||
      message.mediaTypes.some(
        (kind) =>
          !["image", "audio", "video", "file", "forward"].includes(kind),
      )
    )
      throw new Error("invalid media types");
    if (message.mediaTypes.length && message.mediaContent !== "missing")
      throw new Error("unread media must be marked missing");
    if (message.replyTo !== null && !seen.has(message.replyTo))
      throw new Error("reply must cite earlier visible message");
    seen.add(message.id);
    last = time;
  }
  unique(input.turnMessageIds, "turn ids");
  if (
    !input.turnMessageIds.length ||
    input.turnMessageIds.some((id) => !seen.has(id))
  )
    throw new Error("unknown turn input");
  const suffix = input.messages
    .slice(-input.turnMessageIds.length)
    .map((message) => message.id);
  if (JSON.stringify(suffix) !== JSON.stringify(input.turnMessageIds))
    throw new Error("turn must be an ordered suffix of the visible prefix");
  unique(item.reference.replyToInputIds, "reference reply ids");
  if (
    !item.reference.replyToInputIds.length ||
    item.reference.replyToInputIds.some((id) => !seen.has(id))
  )
    throw new Error("unlinked reference reply");
  if (!Array.isArray(item.requiredAnswers))
    throw new Error("requiredAnswers must be an array");
  unique(
    item.requiredAnswers.map((answer) => answer.id),
    "required answer ids",
  );
  for (const answer of item.requiredAnswers) {
    text(answer.id, "answer id");
    text(answer.description, "answer description");
    if (!input.turnMessageIds.includes(answer.inputId))
      throw new Error("required answer must cite turn input");
  }
  return item;
}
function candidateInput(item) {
  validateCase(item);
  return {
    persona: item.input.persona,
    cutoff: item.input.cutoff,
    turnMessageIds: [...item.input.turnMessageIds],
    messages: item.input.messages.map(
      ({ id, sender, receivedAt, text, mediaTypes, replyTo }) => ({
        id,
        sender,
        receivedAt,
        text,
        mediaTypes: [...mediaTypes],
        replyTo,
        ...(mediaTypes.length ? { mediaContent: "missing" } : {}),
      }),
    ),
  };
}
function validateCandidate(item, candidate) {
  text(candidate.id, "candidate id");
  text(candidate.variant, "candidate variant");
  if (
    !item ||
    item.id !== candidate.caseId ||
    !["ok", "error", "timeout"].includes(candidate.status)
  )
    throw new Error("invalid candidate");
  if (candidate.inputSha256 !== digest(candidateInput(item)))
    throw new Error(
      "candidate input hash mismatch; rerun this candidate for the current visible input",
    );
  if (candidate.status === "ok" && typeof candidate.text !== "string")
    throw new Error(
      "candidate text must be a string; empty text records silence",
    );
}
function reviewTemplate(item, candidate) {
  validateCandidate(item, candidate);
  if (candidate.status !== "ok")
    throw new Error("failed candidates cannot receive semantic reviews");
  return {
    candidateId: candidate.id,
    caseSha256: digest(item),
    candidateSha256: digest(candidate),
    status: "pending",
    reviewer: null,
    reviewKind: "human",
    answers: item.requiredAnswers.map(({ id }) => ({
      id,
      status: "uncertain",
      reason: "",
    })),
    extraActions: [],
    extraActionsAssessment: "uncertain",
    note: "",
  };
}
function score(cases, candidates, reviews) {
  unique(
    cases.map((item) => validateCase(item).id),
    "case ids",
  );
  unique(
    candidates.map((candidate) => candidate.id),
    "candidate ids",
  );
  unique(
    reviews.map((review) => review.candidateId),
    "review ids",
  );
  const byCase = new Map(cases.map((item) => [item.id, item]));
  const byReview = new Map(
    reviews.map((review) => [review.candidateId, review]),
  );
  if (
    reviews.some(
      (review) =>
        !candidates.some((candidate) => candidate.id === review.candidateId),
    )
  )
    throw new Error("review has no candidate");
  const results = candidates.map((candidate) => {
    const item = byCase.get(candidate.caseId);
    validateCandidate(item, candidate);
    const result = {
      candidateId: candidate.id,
      caseId: item.id,
      variant: candidate.variant,
      dataKind: item.dataKind,
      inputSha256: candidate.inputSha256,
      status: candidate.status,
    };
    const review = byReview.get(candidate.id);
    if (candidate.status !== "ok") {
      if (review)
        throw new Error("failed candidates cannot receive semantic reviews");
      return result;
    }
    if (!review) return { ...result, status: "pending-review" };
    if (
      review.caseSha256 !== digest(item) ||
      review.candidateSha256 !== digest(candidate)
    )
      throw new Error("stale review hash");
    if (review.status === "pending")
      return { ...result, status: "pending-review" };
    if (
      review.status !== "completed" ||
      !["human", "authored-fixture"].includes(review.reviewKind)
    )
      throw new Error("invalid review status");
    if (
      review.reviewKind === "authored-fixture" &&
      item.dataKind !== "synthetic"
    )
      throw new Error("fixture review requires synthetic case");
    text(review.reviewer, "reviewer");
    text(review.note, "review note");
    unique(
      review.answers?.map((answer) => answer.id),
      "review answer ids",
    );
    const expected = item.requiredAnswers.map((answer) => answer.id).sort();
    if (
      JSON.stringify(review.answers.map((answer) => answer.id).sort()) !==
      JSON.stringify(expected)
    )
      throw new Error("review must assess every required answer");
    for (const answer of review.answers) {
      if (!["answered", "missing", "uncertain"].includes(answer.status))
        throw new Error("invalid answer assessment");
      text(answer.reason, "answer reason");
    }
    if (
      !["complete", "uncertain"].includes(review.extraActionsAssessment) ||
      !Array.isArray(review.extraActions)
    )
      throw new Error("invalid extra action assessment");
    for (const action of review.extraActions) {
      if (!ACTIONS.has(action.kind))
        throw new Error("invalid extra action kind");
      text(action.reason, "extra action reason");
      text(action.excerpt, "extra action excerpt");
      if (!candidate.text.includes(action.excerpt))
        throw new Error("extra action excerpt must occur in candidate");
    }
    return {
      ...result,
      status: "reviewed",
      reviewKind: review.reviewKind,
      missedAnswerIds: review.answers
        .filter((answer) => answer.status === "missing")
        .map((answer) => answer.id),
      uncertainAnswerIds: review.answers
        .filter((answer) => answer.status === "uncertain")
        .map((answer) => answer.id),
      extraActions: review.extraActions,
      extraActionsAssessment: review.extraActionsAssessment,
    };
  });
  const reviewed = results.filter((result) => result.status === "reviewed");
  return {
    protocol: PROTOCOL,
    candidates: results.length,
    reviewed: reviewed.length,
    humanReviewed: reviewed.filter((result) => result.reviewKind === "human")
      .length,
    authoredFixtureReviewed: reviewed.filter(
      (result) => result.reviewKind === "authored-fixture",
    ).length,
    pendingReview: results.filter(
      (result) => result.status === "pending-review",
    ).length,
    errors: results.filter((result) => result.status === "error").length,
    timeouts: results.filter((result) => result.status === "timeout").length,
    missedExplicitQuestion: reviewed.filter(
      (result) => result.missedAnswerIds.length,
    ).length,
    unnecessaryExtraAction: reviewed.filter(
      (result) => result.extraActions.length,
    ).length,
    uncertain: reviewed.filter(
      (result) =>
        result.uncertainAnswerIds.length ||
        result.extraActionsAssessment === "uncertain",
    ).length,
    unrepresentedCaseIds: cases
      .filter(
        (item) => !candidates.some((candidate) => candidate.caseId === item.id),
      )
      .map((item) => item.id),
    results,
  };
}
module.exports = {
  PROTOCOL,
  digest,
  validateCase,
  candidateInput,
  reviewTemplate,
  score,
};
