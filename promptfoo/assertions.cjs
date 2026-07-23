const FRAGMENT_PATTERN =
  /<(template|history|memory|persona|policy|state) source="([^"]+)">\n([\s\S]*?)\n<\/\1>/g;

function assertRoutePrompt(output) {
  return assertExactPrompt(
    output,
    [
      fragment("persona", "route-persona", "ROUTE_PERSONA"),
      fragment("history", "route-history", "user: ROUTE_HISTORY"),
      fragment("memory", "route-memory", "ROUTE_MEMORY"),
      fragment("policy", "route-policy", "ROUTE_POLICY"),
    ],
    "route Prompt",
  );
}

function assertReplyPrompt(output) {
  const exact = assertExactPrompt(
    output,
    [
      fragment("persona", "reply-persona", "REPLY_PERSONA"),
      fragment("history", "reply-history", "user: REPLY_HISTORY"),
      fragment("memory", "reply-memory", "REPLY_MEMORY"),
      fragment("policy", "reply-policy", "REPLY_POLICY"),
    ],
    "reply Prompt",
  );
  if (!exact.pass) {
    return exact;
  }

  const excludesRoutePolicy =
    !output.includes("ROUTE_ONLY_POLICY") &&
    !output.includes('source="route-policy"');
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
      fragment("history", "state-history", "user: STATE_HISTORY"),
      fragment("state", "state-current", "STATE_CURRENT"),
      fragment("policy", "state-policy", "SHORT_TERM_STATE_POLICY"),
    ],
    "state Prompt",
  );
}

function assertMemoryPrompt(output) {
  const exact = assertExactPrompt(
    output,
    [
      fragment(
        "history",
        "memory-history",
        "user: WINDOW_START\nassistant: WINDOW_MIDDLE\nuser: WINDOW_END",
      ),
      fragment("policy", "memory-policy", "MEMORY_POLICY"),
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

  const actual = [...output.matchAll(FRAGMENT_PATTERN)].map((match) =>
    fragment(match[1], match[2], match[3]),
  );
  const reconstructed = actual.map(renderFragment).join("\n\n");
  if (reconstructed !== output) {
    return grade(false, "", `${label} 含有无法识别的片段或分隔符`);
  }

  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  return grade(
    pass,
    `${label} 的来源、顺序、标识与内容均符合预期`,
    `${label} 结构不符：expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
  );
}

function fragment(source, id, content) {
  return { source, id, content };
}

function renderFragment(value) {
  return `<${value.source} source="${value.id}">\n${value.content}\n</${value.source}>`;
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
