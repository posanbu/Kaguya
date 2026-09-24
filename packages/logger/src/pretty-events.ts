/**
 * 功能概述：为需要成组阅读的模块输入、领域输出与记忆日志选择终端面板主题。
 * 主要职责：prettyPanelForLog 仅匹配实际已有的 event/taskId，返回标题、边框颜色和正文标签；
 * modelTaskName 区分 Planner、回复生成、人物记忆及表达学习，未知任务保留原 taskId。
 * 代码库关系：pretty.ts 在 Pino 完成脱敏后查询本表；事件对应 Runtime 模型请求及 modules
 * 的 log.project，面板不查账本、不组合不同请求、不凭空补出模型返回或召回原文。
 * 输入输出与副作用：纯展示元数据；普通生命周期保持日志行，JSON 与日志级别不受影响。
 */
export interface PrettyEventPanel {
  readonly title: string;
  readonly color: number;
  readonly fieldsTitle: string;
  readonly contentTitle?: string;
}

const PANELS: Readonly<Record<string, PrettyEventPanel>> = {
  "turn.plan": {
    title: "Planner · 决策输出",
    color: 32,
    fieldsTitle: "决策",
    contentTitle: "决策依据",
  },
  "attention.observation": {
    title: "注意力 · 观察结果",
    color: 36,
    fieldsTitle: "观察事实",
  },
  "attention.arousal.state": {
    title: "注意力 · 唤醒状态",
    color: 36,
    fieldsTitle: "状态事实",
  },
  "message.assistant": {
    title: "回复生成 · 输出",
    color: 33,
    fieldsTitle: "生成信息",
    contentTitle: "回复正文预览",
  },
  "message.intent.requested": {
    title: "回复生成 · 输入选择",
    color: 33,
    fieldsTitle: "生成请求",
  },
  "memory.association.query": {
    title: "记忆联想 · 检索输入",
    color: 35,
    fieldsTitle: "检索条件",
    contentTitle: "查询文本预览",
  },
  "memory.association.candidate": {
    title: "记忆联想 · 召回候选",
    color: 35,
    fieldsTitle: "候选信息",
  },
  "memory.association.completed": {
    title: "记忆联想 · 检索结果",
    color: 35,
    fieldsTitle: "召回结果",
  },
  "memory.text.registered": {
    title: "记忆 · 正文登记",
    color: 35,
    fieldsTitle: "记忆信息",
    contentTitle: "记忆正文预览",
  },
  "memory.writeback.requested": {
    title: "原始记忆 · 写入请求",
    color: 35,
    fieldsTitle: "请求信息",
  },
  "memory.writeback.terminal": {
    title: "原始记忆 · 写入结果",
    color: 35,
    fieldsTitle: "写入状态",
  },
  "person.fact.candidate": {
    title: "人物记忆 · 提取输入",
    color: 35,
    fieldsTitle: "输入信息",
    contentTitle: "来源文本预览",
  },
  "person.fact.extracted": {
    title: "人物记忆 · 提取输出",
    color: 35,
    fieldsTitle: "提取信息",
    contentTitle: "事实正文预览",
  },
  "memory.expression.learned": {
    title: "表达学习 · 输出",
    color: 33,
    fieldsTitle: "学习结果",
  },
  "memory.expression.selected": {
    title: "表达选择 · 输出",
    color: 33,
    fieldsTitle: "选择结果",
  },
};

export function prettyPanelForLog(
  log: Record<string, unknown>,
): PrettyEventPanel | undefined {
  if (typeof log.event !== "string") return undefined;
  if (
    log.event === "model.task.prompt" &&
    log.detail === true &&
    typeof log.promptFull === "string"
  ) {
    return {
      title: `${modelTaskName(log.taskId)} · 输入 Prompt`,
      color: 36,
      fieldsTitle: "请求信息",
    };
  }
  if (log.event === "model.task.lifecycle") {
    if (log.status === "requested" && typeof log.promptPreview === "string") {
      return {
        title: `${modelTaskName(log.taskId)} · 输入预览`,
        color: 36,
        fieldsTitle: "请求信息",
      };
    }
    if (log.status === "failed")
      return {
        title: `${modelTaskName(log.taskId)} · 执行失败`,
        color: 31,
        fieldsTitle: "失败信息",
      };
  }
  // info 级人物事实目前只有完成事件，正文只在 debug detail 中出现，避免生成空内容框。
  if (
    log.event === "person.fact.extracted" &&
    typeof log.contentPreview !== "string"
  )
    return undefined;
  if (/^(napcat|web)\.inbound\.(submitted|filtered|failed)$/u.test(log.event)) {
    return {
      title: "消息接收 · 输入",
      color: 36,
      fieldsTitle: "来源与处理状态",
      contentTitle: "消息正文",
    };
  }
  return Object.hasOwn(PANELS, log.event) ? PANELS[log.event] : undefined;
}

function modelTaskName(taskId: unknown): string {
  const names: Readonly<Record<string, string>> = {
    "agent.turn.plan": "Planner",
    "agent.message.compose": "回复生成",
    "core.person.fact.extract": "人物记忆",
    "memory.expression.learn": "表达学习",
    "memory.expression.select": "表达选择",
  };
  return typeof taskId === "string" && taskId
    ? Object.hasOwn(names, taskId)
      ? names[taskId]!
      : taskId
    : "模型任务";
}
