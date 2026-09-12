/**
 * 功能概述：promptfoo 离线结构回归的评分入口，返回 pass、score 和可定位的失败原因。
 * 主要职责：assertMessagePrompt 检查真实消息编译器的整轮输入与无特权目标；其余入口检查对应通用模板。
 * 代码库关系：promptfooconfig.yaml 引用这些导出，provider.cjs 负责实际生成文本。
 * 输入输出与副作用：只检查输出字符串，不读取文件、不访问网络或修改运行状态。
 */
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

function assertMessagePrompt(output) {
  const pass =
    typeof output === "string" &&
    output.includes("MESSAGE_PERSONA") &&
    output.includes("FIRST_TURN_INPUT") &&
    output.includes("LAST_TURN_INPUT") &&
    output.includes("【本轮输入】") &&
    !output.includes("【目标消息】") &&
    !output.includes("LEGACY_COPIED_BODY") &&
    !output.includes("ROUTE_ONLY_POLICY");
  return grade(
    pass,
    "message Prompt 包含全部冻结输入且无特殊末条目标",
    "message Prompt 丢失整轮输入或泄漏旧版目标正文",
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
  assertMessagePrompt,
  assertRoutePrompt,
  assertStatePrompt,
};
