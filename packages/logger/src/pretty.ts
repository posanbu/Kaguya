/**
 * 功能概述：把 Pino 已完成 serializer/redaction 的记录排成面向人的中文控制台日志。
 * 主要职责：createPrettyOptions 配置时间与级别；formatPrettyMessage 分离模块、摘要、正文、
 * 业务字段和 DAG 溯源；模块输入、领域输出和记忆通过 pretty-events.ts 选取主题，
 * pretty-panel.ts 按终端宽度画分区框，框内字段依据共享正文列宽优先完整折行；
 * supportsPrettyColors 尊重终端、NO_COLOR 与 TERM=dumb。
 * 代码库关系：由 index.ts 的同步 pretty 输出调用；展示词表对应 Server、AdapterHost、
 * ModuleHost 和 Information kind 的稳定事件码，未知模块、事件及字段原样显示。
 * 输入输出与副作用：纯函数，不读取业务载荷、不修改记录、不改变日志级别或 JSON 输出。
 * Prompt 仅在既有 detail 记录中展开；模型失败的 Provider 状态、稳定原因和固定建议
 * 使用中文标签展示，外部文本的终端控制字符转义，所有续行显式缩进。
 */
import type { PrettyOptions } from "pino-pretty";
import stringWidth from "string-width";

import { prettyPanelForLog } from "./pretty-events.js";
import {
  getPrettyPanelContentWidth,
  renderPrettyPanel,
  type PrettyPanelSection,
} from "./pretty-panel.js";

const MODULE_NAMES: Readonly<Record<string, string>> = {
  server: "主程序",
  "server:http": "HTTP",
  runtime: "运行时",
  "runtime:modules": "模块",
  "runtime:information": "信息流",
  "adapter:napcat": "NapCat",
  "adapter:web": "网页聊天",
  "agent.heartflow.online": "心流",
  "agent.message-composer": "消息生成",
  "memory.association": "联想",
  "memory.writeback": "记忆写入",
  "demo.person.fact.extract": "人物记忆",
};

const EVENT_NAMES: Readonly<Record<string, string>> = {
  "server.starting": "正在启动 Kaguya",
  "server.started": "Kaguya 服务已启动",
  "server.start.failed": "Kaguya 启动失败",
  "server.stopping": "正在停止 Kaguya",
  "server.stopped": "Kaguya 已停止",
  "server.shutdown.failed": "Kaguya 停止失败",
  "server.degraded": "下游服务不可用，已进入降级状态",
  "server.degraded.cleanup.failed": "降级资源清理失败",
  "runtime.started": "运行时已就绪",
  "runtime.stopped": "运行时已停止",
  "runtime.context": "建立运行时上下文",
  "modules.assembled": "模块装配完成",
  "modules.start.failed": "模块启动失败",
  "module.starting": "正在启动模块",
  "module.started": "模块已启动",
  "module.start.failed": "模块启动失败",
  "module.status.failed": "无法读取模块启动状态",
  "module.diagnostic.rejected": "模块诊断被拒绝",
  "information.log.failed": "信息日志投影失败",
  "information.log.outbox.failed": "信息日志写入失败",
  "information.bootstrap.failed": "信息引导失败",
  "memory.vector.unavailable": "向量记忆不可用",
  "memory.recall.failed": "记忆召回失败",
  "scheduler.cadence.failed": "节奏调度失败",
  "model.task.prompt": "模型任务 Prompt 详情",
  "message.model.dispatching": "准备生成回复",
  "person-fact.model.dispatching": "准备提取人物记忆",
  "message.inbound": "收到消息",
  "message.assistant": "回复已生成",
  "message.intent.requested": "请求生成消息",
  "message.content.confirmed": "消息正文已确认",
  "message.target.resolved": "消息目标已解析",
  "message.target.authorized": "消息目标已授权",
  "conversation.context": "会话上下文已准备",
  "delivery.requested": "请求投递消息",
  "turn.started": "回合已开始",
  "turn.claimed": "回合已认领",
  "turn.context.completed": "回合上下文已准备",
  "attention.observation": "注意力观察",
  "attention.arousal.state": "Arousal 唤醒状态",
  "turn.decision.interrupted": "回合决策已中断",
  "turn.decision.superseded": "回合决策已被替代",
  "turn.plan": "回合规划完成",
  "speech.wait.requested": "等待下一次唤醒",
  "memory.association.retrieval.started": "开始检索联想记忆",
  "memory.association.completed": "联想检索完成",
  "memory.association.query": "查询联想记忆",
  "memory.association.candidate": "找到记忆候选",
  "memory.text.registered": "记忆正文已登记",
  "memory.writeback.requested": "原始记忆写入请求已登记",
  "person.fact.candidate": "准备提取人物事实",
  "person.fact.extracted": "人物事实提取完成",
  "memory.expression.learned": "表达习惯学习完成",
  "memory.expression.selected": "表达习惯选择完成",
  "consumer.failed": "信息处理失败",
  "execution.exhausted": "执行重试已耗尽",
};

const STATUS_NAMES: Readonly<Record<string, string>> = {
  requested: "已请求",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  delivered: "已送达",
  silent: "保持安静",
  superseded: "已被替代",
  interrupted: "已中断",
  starting: "正在启动",
  connecting: "正在连接",
  connected: "已连接",
  disconnected: "已断开",
  retrying: "等待重连",
  stopping: "正在停止",
  stopped: "已停止",
  disabled: "未启用",
  ready: "就绪",
  degraded: "降级",
  submitted: "已提交",
  filtered: "已过滤",
  matched: "命中",
  empty: "无结果",
  "policy-filtered": "已被策略过滤",
  unavailable: "不可用",
};

const FIELD_NAMES: Readonly<Record<string, string>> = {
  host: "监听",
  port: "端口",
  napcatEnabled: "NapCat",
  runtimeReady: "运行时",
  adapterHostState: "适配器状态",
  degradationReasons: "降级原因",
  status: "状态",
  connectivity: "连接",
  availability: "可用性",
  adapterId: "适配器",
  platform: "平台",
  senderId: "发送者",
  targetKind: "会话类型",
  definitionId: "模块定义",
  instanceId: "实例",
  moduleCount: "模块数",
  order: "启动顺序",
  transportCount: "通道数",
  taskId: "任务",
  taskVersion: "任务版本",
  providerId: "服务商",
  modelId: "模型",
  durationMs: "耗时",
  responseTime: "耗时",
  delayMs: "延迟",
  attempt: "尝试次数",
  nextRetryAt: "下次重试",
  promptCharacters: "Prompt 字符数",
  promptVariableCount: "变量数",
  contentLength: "正文字符数",
  contentTruncated: "正文已截断",
  outcome: "结果",
  score: "得分",
  reasonCodes: "原因",
  errorType: "错误类型",
  errorKind: "错误分类",
  failureStage: "失败阶段",
  providerStatusCode: "上游 HTTP",
  providerErrorCode: "Provider 错误码",
  providerErrorType: "Provider 错误类型",
  providerFailureReason: "诊断",
  providerAction: "处理建议",
  phase: "阶段",
  err: "错误",
  error: "错误",
  attemptCount: "尝试次数",
  action: "动作",
  route: "检索入口",
  method: "检索方法",
  strategy: "检索策略",
  queryLength: "查询字符数",
  limit: "候选上限",
  rank: "候选序号",
  candidateCount: "候选数量",
  count: "数量",
};

const LIFECYCLE_NAMES: Readonly<Record<string, string>> = {
  "model.task.lifecycle": "模型任务",
  "delivery.lifecycle": "消息投递",
  "turn.lifecycle": "回合",
  "heartbeat.lifecycle": "心跳",
  "memory.writeback.terminal": "记忆写入",
};

const MESSAGE_NAMES: Readonly<Record<string, string>> = {
  "Information DAG heartflow ready": "心流已就绪",
  "Message composer pipeline ready": "消息生成已就绪",
  "Memory association ready": "联想记忆已就绪",
  "Person-fact extraction pipeline ready": "人物记忆提取已就绪",
  "Attention arousal gate ready": "注意力评估已就绪",
  "Identity normalization ready": "身份解析已就绪",
  "Durable short heartbeat ready": "持久化心跳已就绪",
  "Message model task dispatching": "准备生成回复",
  "Person-fact model task dispatching": "准备提取人物记忆",
  "Association retrieval started": "开始检索联想记忆",
  "incoming request": "收到 HTTP 请求",
  "request completed": "HTTP 请求完成",
};

// 身份和溯源单列；保留完整字段名，便于与 JSON 记录对照。
const TRACE_KEYS = new Set([
  "source",
  "requestId",
  "reqId",
  "workflowId",
  "nodeId",
  "rootInformationId",
  "sourceInformationId",
  "contextInformationId",
  "occurredAt",
  "sensitivity",
]);
const HEADER_KEYS = new Set([
  "time",
  "level",
  "pid",
  "hostname",
  "service",
  "module",
  "msg",
  "promptFull",
  "promptVariables",
]);
const PALETTE = [36, 35, 34, 32, 33] as const;

export function supportsPrettyColors(
  isTTY: boolean | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isTTY === true &&
    environment.NO_COLOR === undefined &&
    environment.TERM !== "dumb"
  );
}

export function createPrettyOptions(
  colorize = false,
  columns: () => number | undefined = () => undefined,
): PrettyOptions {
  return {
    // 颜色仅用于级别、模块标题和溯源；禁用 pino-pretty 对整段正文的青色染色。
    colorize: false,
    translateTime: "SYS:HH:MM:ss",
    singleLine: false,
    hideObject: true,
    // messageFormat 先读取完整记录，再阻止 pino-pretty 重复输出未转义的 metadata 或 legacy Error。
    ignore: "pid,hostname,name,caller,type,stack",
    messageFormat: (log) => formatPrettyMessage(log, colorize, columns()),
    customPrettifiers: {
      time: (value) => `[${oneLine(String(value))}]`,
      level: (value) => {
        const level = String(value).toLowerCase();
        const colors: Record<string, number> = {
          trace: 90,
          debug: 34,
          info: 32,
          warn: 33,
          error: 31,
          fatal: 31,
        };
        return paint(
          oneLine(level.toUpperCase()),
          colors[level] ?? 37,
          colorize,
        );
      },
    },
  };
}

export function formatPrettyMessage(
  log: Record<string, unknown>,
  colorize = false,
  columns?: number,
): string {
  const namespace = string(log.module) || string(log.service) || "Kaguya";
  const moduleId = namespace.startsWith("runtime:module:")
    ? namespace.slice("runtime:module:".length)
    : namespace;
  const moduleName = ownValue(MODULE_NAMES, moduleId) ?? moduleId;
  const event = string(log.event);
  const message = string(log.msg);
  const summary = eventSummary(event, log);
  // describeStartup 等调用方提供的具体说明优先保留，固定英文模板才用事件摘要代替。
  const title =
    ownValue(MESSAGE_NAMES, message) ??
    (message && !isGenericMessage(message, event)
      ? message
      : summary || message || string(log.kind) || "日志记录");
  const heading = paint(
    `[${oneLine(moduleName)}]`,
    moduleColor(moduleId),
    colorize,
  );
  const lines = [`${heading} ${safeText(title).replaceAll("\n", "\n    ")}`];
  const panel = prettyPanelForLog(log);
  const panelContentWidth = getPrettyPanelContentWidth(columns);
  const sections: PrettyPanelSection[] = [];
  const addSection = (label: string, value: string) => {
    if (panel)
      sections.push({ title: label, lines: safeText(value).split("\n") });
    else lines.push(block(label, value));
  };
  const used = new Set(HEADER_KEYS);
  if (title === summary) {
    if (
      !panel &&
      ownValue(LIFECYCLE_NAMES, event) &&
      typeof log.status === "string"
    )
      used.add("status");
    if (
      /^(napcat|web)\.connection\./u.test(event) &&
      event.endsWith(`.${string(log.connectivity)}`)
    )
      used.add("connectivity");
  }

  for (const [key, label] of [
    ["messageText", "消息"],
    ["contentPreview", "正文预览"],
    ["promptPreview", "Prompt 预览"],
  ] as const) {
    if (typeof log[key] === "string") {
      addSection(
        key === "contentPreview" || key === "messageText"
          ? (panel?.contentTitle ?? label)
          : label,
        log[key],
      );
      used.add(key);
    }
  }
  if (log.detail === true && typeof log.promptFull === "string") {
    addSection("Prompt", log.promptFull);
    used.add("promptFull");
    if (Array.isArray(log.promptVariables)) {
      const variables = log.promptVariables.filter(isRecord).map((variable) => {
        const ids = Array.isArray(variable.informationIds)
          ? variable.informationIds
              .filter((id): id is string => typeof id === "string")
              .map(shortInformationId)
              .join(",") || "-"
          : "-";
        return `${oneLine(string(variable.variableName) || "unknown")} information=${ids} digest=${oneLine(string(variable.contentDigest) || "unknown")}`;
      });
      if (variables.length) addSection("Provenance", variables.join("\n"));
      used.add("promptVariables");
    }
  }

  if (panel && typeof log.reason === "string") {
    addSection("原因说明", log.reason);
    used.add("reason");
  }
  if (panel && Array.isArray(log.habitSummaries)) {
    addSection(
      "表达习惯",
      log.habitSummaries.length
        ? log.habitSummaries.map((habit) => String(habit)).join("\n")
        : "本次没有表达习惯",
    );
    used.add("habitSummaries");
  }

  const trace: string[] = [];
  if (event) {
    // 未知事件已作为标题出现时不再重复。
    if (title !== event) trace.push(`event=${oneLine(event)}`);
    used.add("event");
  }
  if (typeof log.informationId === "string" && typeof log.kind === "string") {
    trace.push(
      `[${shortInformationId(log.informationId)}] ${oneLine(log.kind)}${formatReferences(log.references)}`,
    );
    used.add("informationId");
    used.add("kind");
    if (Array.isArray(log.references) && log.references.every(isReference))
      used.add("references");
  }
  if (log.detail === true) {
    trace.push("detail=true");
    used.add("detail");
  }

  const fields: string[] = [];
  for (const [key, value] of Object.entries(log)) {
    if (used.has(key) || value === undefined) continue;
    if (TRACE_KEYS.has(key)) {
      trace.push(`${key}=${oneLine(formatValue(key, value))}`);
    } else if (
      isRecord(value) ||
      (Array.isArray(value) && value.some(isRecord))
    ) {
      const entries = Array.isArray(value) ? value : [value];
      const rows = entries.flatMap((entry) => {
        const parts = isRecord(entry)
          ? Object.entries(entry).map(
              ([name, item]) =>
                `${oneLine(ownValue(FIELD_NAMES, name) ?? name)}=${oneLine(formatValue(name, item))}`,
            )
          : [oneLine(formatValue("", entry))];
        const wrapped = wrapFields(
          parts,
          panel ? panelContentWidth - 2 : undefined,
        );
        return wrapped.length
          ? wrapped.map(
              (line, index) =>
                `${index === 0 && Array.isArray(value) ? "- " : "  "}${line.trimStart()}`,
            )
          : [Array.isArray(value) ? "- {}" : "{}"];
      });
      addSection(ownValue(FIELD_NAMES, key) ?? key, rows.join("\n"));
    } else if (typeof value === "string" && value.includes("\n")) {
      addSection(ownValue(FIELD_NAMES, key) ?? key, value);
    } else {
      fields.push(
        `${oneLine(ownValue(FIELD_NAMES, key) ?? key)}=${oneLine(formatValue(key, value))}`,
      );
    }
  }
  if (panel) {
    if (fields.length)
      sections.unshift({
        title: panel.fieldsTitle,
        lines: wrapFields(fields, panelContentWidth).map((line) =>
          line.slice(2),
        ),
      });
    if (!sections.length)
      sections.push({ title: panel.fieldsTitle, lines: [title] });
    lines.push(
      renderPrettyPanel({
        title: panel.title,
        sections,
        colorize,
        color: panel.color,
        ...(columns === undefined ? {} : { columns }),
      }),
    );
  } else lines.push(...wrapFields(fields));
  lines.push(...wrapFields(trace).map((line) => paint(line, 90, colorize)));
  return lines.join("\n");
}

function eventSummary(event: string, log: Record<string, unknown>): string {
  const known = ownValue(EVENT_NAMES, event);
  if (known) return known;
  const lifecycle = ownValue(LIFECYCLE_NAMES, event);
  if (lifecycle)
    return `${lifecycle} · ${statusName(string(log.status)) || "状态更新"}`;
  const adapter = /^(napcat|web)\.(connection|inbound)\.([a-z_]+)$/u.exec(
    event,
  );
  if (adapter) {
    const stage = adapter[3]!;
    if (adapter[2] === "inbound") {
      return (
        ownValue(
          {
            submitted: "收到消息 · 已提交处理",
            filtered: "收到消息 · 已被过滤",
            failed: "收到消息 · 提交失败",
          },
          stage,
        ) ?? `收到消息 · ${statusName(stage)}`
      );
    }
    return `连接状态 · ${statusName(stage)}`;
  }
  return event;
}

function isGenericMessage(message: string, event: string): boolean {
  return (
    message === event ||
    [
      "Kaguya server starting",
      "Kaguya server started",
      "Kaguya server startup failed",
      "Kaguya server stopping",
      "Kaguya server stopped",
      "Kaguya server shutdown failed",
      "Kaguya runtime started",
      "Kaguya runtime stopped",
      "Information modules assembled",
      "Information module starting",
      "Information module started",
      "Information module startup failed",
      "Information module startup status failed",
      "Adapter state updated",
      "Adapter inbound message",
      "Server downstream unavailable",
    ].includes(message)
  );
}

function formatValue(key: string, value: unknown): string {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    ["durationMs", "responseTime", "delayMs"].includes(key)
  ) {
    return value >= 1_000
      ? `${Number((value / 1_000).toFixed(2))} s`
      : `${Number(value.toFixed(2))} ms`;
  }
  if (typeof value === "boolean") {
    if (key === "runtimeReady") return value ? "就绪" : "未就绪";
    if (key === "napcatEnabled") return value ? "开启" : "关闭";
    return value ? "是" : "否";
  }
  if (typeof value === "string") {
    if (
      ["status", "adapterHostState", "connectivity", "availability"].includes(
        key,
      )
    )
      return statusName(value);
    if (key === "outcome")
      return (
        ownValue({ observe: "查看未读", defer: "延后观察" }, value) ?? value
      );
    if (key === "state")
      return ownValue({ awake: "唤醒态", asleep: "休眠态" }, value) ?? value;
    if (key === "targetKind")
      return (
        ownValue({ group: "群聊", private: "私聊", web: "网页" }, value) ??
        value
      );
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

function formatReferences(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const grouped = new Map<string, string[]>();
  for (const reference of value.filter(isReference)) {
    const ids = grouped.get(reference.relation) ?? [];
    ids.push(shortInformationId(reference.informationId));
    grouped.set(reference.relation, ids);
  }
  return grouped.size
    ? ` ← ${[...grouped].map(([relation, ids]) => `${oneLine(relation)}:${ids.join(",")}`).join(" · ")}`
    : "";
}

function isReference(
  value: unknown,
): value is { relation: string; informationId: string } {
  return (
    isRecord(value) &&
    typeof value.relation === "string" &&
    typeof value.informationId === "string"
  );
}

function block(label: string, value: string): string {
  return `  ${oneLine(label)}:\n${safeText(value)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}`;
}

// 优先按完整字段折行；面板使用真实正文列宽，单个超长字段交给 renderer 按 grapheme 换行。
// 非面板日志保留原有 100 列字段分组风格。
function wrapFields(fields: readonly string[], columns = 100): string[] {
  const lines: string[] = [];
  let line = "";
  for (const field of fields) {
    const next = line ? `${line} · ${field}` : field;
    if (line && stringWidth(next) > columns) {
      lines.push(`  ${line}`);
      line = field;
    } else line = next;
  }
  if (line) lines.push(`  ${line}`);
  return lines;
}

function moduleColor(module: string): number {
  let hash = 0;
  for (const char of module) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

function paint(value: string, color: number, enabled: boolean): string {
  return enabled ? `\u001b[${color}m${value}\u001b[0m` : value;
}

function safeText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replace(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
      (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`,
    );
}

function oneLine(value: string): string {
  return safeText(value).replaceAll("\n", "\\n");
}

function shortInformationId(value: string): string {
  return oneLine(Array.from(value).slice(0, 8).join(""));
}

function statusName(value: string): string {
  return ownValue(STATUS_NAMES, value) ?? value;
}

function ownValue(
  values: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
