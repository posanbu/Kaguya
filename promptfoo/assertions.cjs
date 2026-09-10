function assertRoutePrompt(output) {
  return assertExactPrompt(
    output,
    [
      value("route-persona", "ROUTE_PERSONA"),
      value("route-history", "user: ROUTE_HISTORY"),
      value("route-memory", "ROUTE_MEMORY"),
      value("route-policy", "ROUTE_POLICY"),
    ],
    "route Prompt",
  );
}

function assertReplyPrompt(output) {
  const exact = assertExactPrompt(
    output,
    [
      value("reply-persona", "REPLY_PERSONA"),
      value("reply-history", "user: REPLY_HISTORY"),
      value("reply-memory", "REPLY_MEMORY"),
      value("reply-policy", "REPLY_POLICY"),
    ],
    "reply Prompt",
  );
  if (!exact.pass) {
    return exact;
  }

  const excludesRoutePolicy =
    !output.includes("ROUTE_ONLY_POLICY") && !output.includes("[route-policy]");
  return grade(
    excludesRoutePolicy,
    "reply Prompt 仅包含 reply 策略",
    "reply Prompt 泄漏了仅供 route 使用的策略",
  );
}

function assertStatePrompt(output) {
  return assertExactPrompt(
    output,
    [
      value("state-history", "user: STATE_HISTORY"),
      value("state-current", "STATE_CURRENT"),
      value("state-policy", "SHORT_TERM_STATE_POLICY"),
    ],
    "state Prompt",
  );
}

function assertMemoryPrompt(output) {
  const exact = assertExactPrompt(
    output,
    [
      value(
        "memory-history",
        "user: WINDOW_START\nassistant: WINDOW_MIDDLE\nuser: WINDOW_END",
      ),
      value("memory-policy", "MEMORY_POLICY"),
    ],
    "memory Prompt",
  );
  if (!exact.pass) {
    return exact;
  }

  const excludesOutsideWindow =
    !output.includes("BEFORE_WINDOW") && !output.includes("AFTER_WINDOW");
  return grade(
    excludesOutsideWindow,
    "memory Prompt 仅包含闭区间内的记录与 memory policy",
    "memory Prompt 包含请求窗口外的记录",
  );
}

function assertExactPrompt(output, expected, label) {
  if (typeof output !== "string") {
    return grade(false, "", `${label} 输出不是字符串`);
  }

  const rendered = expected.map(renderFragment).join("\n\n");
  const pass = output === rendered;
  return grade(
    pass,
    `${label} 的顺序、标识与内容均符合预期`,
    `${label} 结构不符：expected=${JSON.stringify(rendered)} actual=${JSON.stringify(output)}`,
  );
}

function value(id, content) {
  return { id, content };
}

function renderFragment(value) {
  return `[${value.id}]\n${value.content}`;
}

function grade(pass, successReason, failureReason) {
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? successReason : failureReason,
  };
}

module.exports = {
  assertMemoryPrompt,
  assertReplyPrompt,
  assertRoutePrompt,
  assertStatePrompt,
};
