/**
 * 功能概述：用虚构的启动、Planner 输入输出、回复、记忆、表达学习和失败记录预览控制台框。
 * 主要职责：沿 createLogger/createModuleLogger 的真实输出路径写入与 kind 投影同名的字段；
 * previewInformationContent 生成受限正文，historyDigest 为虚构变量生成摘要，--json 对照机器格式。
 * 代码库关系：根 pnpm logs:preview 先构建 logger，再执行本文件；不导入业务服务、不启动 Server 或连接数据库。
 * 输入输出与副作用：仅输出到 stdout，不读取 Profile、凭据或真实聊天；固定 debug 展示各层级，结束前刷新 logger。
 * 候选只含排名、原因与来源引用，writeback 只含终态；样例不为没有正文的投影补造内容。
 */
import { createHash } from "node:crypto";
import {
  closeLogger,
  createLogger,
  createModuleLogger,
  previewInformationContent,
} from "../packages/logger/dist/index.js";

const root = createLogger({
  service: "kaguya-preview",
  format: process.argv.includes("--json") ? "json" : "pretty",
  level: "debug",
});
const server = createModuleLogger(root, "server");
const adapter = createModuleLogger(root, "adapter:napcat");
const information = createModuleLogger(root, "runtime:information");
const history =
  "用户：辉夜，明天一起看月亮吗？\n记得带上望远镜 🌙，如果天气不好，我们就在室内整理上次的观测笔记。";
const historyDigest = createHash("sha256").update(history).digest("hex");

createModuleLogger(root, "runtime:modules").info(
  {
    event: "modules.assembled",
    moduleCount: 2,
    order: [
      { definitionId: "agent.heartflow.online", instanceId: "heartflow-demo" },
      { definitionId: "agent.message-composer", instanceId: "composer-demo" },
    ],
  },
  "Information modules assembled",
);

server.info(
  {
    event: "server.started",
    host: "127.0.0.1",
    port: 3000,
    napcatEnabled: true,
    runtimeReady: true,
    adapterHostState: "ready",
  },
  "Kaguya server started",
);
adapter.info(
  {
    event: "napcat.connection.connected",
    adapterId: "napcat",
    connectivity: "connected",
  },
  "Adapter state updated",
);
adapter.info(
  {
    event: "napcat.inbound.submitted",
    senderId: "demo-user",
    targetKind: "group",
    messageText: history,
    rootInformationId: "demo-inbound-0001",
  },
  "Adapter inbound message",
);
information.info({
  event: "turn.decision",
  outcome: "attend",
  score: 0.86,
  reasonCodes: ["direct_mention"],
});
information.debug({
  event: "model.task.prompt",
  status: "requested",
  detail: true,
  sensitivity: "content",
  taskId: "agent.turn.plan",
  taskVersion: "1",
  promptFull: [
    "你是辉夜的回合规划器。请根据当前对话决定回复、等待或保持安静。",
    "判断时关注用户当前的问题、已有回复与打断风险；输出经过结构约束的动作和原因。",
    "当前对话：",
    history,
    "当前会话：虚构的天文兴趣小组。用户直接邀请辉夜参加观测；当前没有其他成员正在回答。",
    "此处为本地排版样例，所有人物、对话和信息 ID 都是虚构的。🔭🌙",
  ].join("\n"),
  promptVariables: [
    {
      variableName: "history",
      informationIds: ["inbound1-demo"],
      contentDigest: historyDigest,
    },
  ],
  informationId: "planreq1-demo",
  kind: "core.model.task.requested",
  references: [
    { relation: "core:uses-context", informationId: "inbound1-demo" },
  ],
});
information.info({
  event: "turn.plan",
  action: "message",
  reason: "respond",
  informationId: "planout1-demo",
  kind: "agent.turn.plan.completed",
  references: [{ relation: "core:caused-by", informationId: "planmdl1-demo" }],
});

const memoryText = [
  "虚构用户喜欢观测月亮，曾在天文兴趣小组讨论使用望远镜拍摄月面。",
  "上次观测时，他负责带观测笔记和星图，辉夜负责整理器材清单；如果天空被云层遮住，大家会先在室内交流照片。",
  "他们约定先确认天气和集合时间，再讨论交通与器材安排，不把尚未确定的计划写成已经发生的事情。🔭",
  "这段长文本用于检查中文和 emoji 在窄终端中的换行，以及正文超过预览上限时的截断提示。",
].join("\n");
information.debug({
  event: "memory.text.registered",
  ...previewInformationContent(memoryText),
  informationId: "memory01-demo",
  kind: "memory.text",
  references: [
    { relation: "core:uses-context", informationId: "oldchat1-demo" },
  ],
});
const query = "明天一起看月亮，望远镜与上次观测笔记 🌙";
information.debug({
  event: "memory.association.query",
  method: "sparse-2gram",
  route: "message",
  queryLength: Array.from(query).length,
  limit: 3,
  ...previewInformationContent(query),
  informationId: "query001-demo",
  kind: "memory.association.query",
  references: [{ relation: "core:caused-by", informationId: "assocreq-demo" }],
});
information.debug({
  event: "memory.association.candidate",
  rank: 0,
  strategy: "sparse-2gram",
  reasonCodes: ["sparse-match", "coverage-ranked"],
  informationId: "cand0001-demo",
  kind: "memory.association.candidate",
  references: [
    { relation: "core:caused-by", informationId: "query001-demo" },
    { relation: "agent:canonical-source", informationId: "memory01-demo" },
  ],
});
information.info({
  event: "memory.association.completed",
  status: "matched",
  route: "message",
  method: "sparse-2gram",
  candidateCount: 1,
  reasonCodes: ["sparse-match", "coverage-ranked"],
  informationId: "assoc001-demo",
  kind: "memory.association.completed",
  references: [
    { relation: "core:caused-by", informationId: "query001-demo" },
    { relation: "agent:candidate", informationId: "cand0001-demo" },
  ],
});
information.debug({
  event: "memory.expression.learned",
  status: "completed",
  count: 2,
  habitSummaries: ["分享喜悦 → 简短感叹", "礼貌回应 → 先回应再补充"],
  informationId: "exprlrn1-demo",
  kind: "memory.expression.learning.completed",
  references: [{ relation: "core:caused-by", informationId: "exprmdl1-demo" }],
});
information.debug({
  event: "memory.expression.selected",
  count: 1,
  reason: "当前对话是熟悉朋友之间的活动邀请。",
  habitSummaries: ["礼貌回应 → 先回应再补充"],
  informationId: "exprsel1-demo",
  kind: "memory.expression.selection.completed",
  references: [{ relation: "core:caused-by", informationId: "exprmdl2-demo" }],
});
information.debug({
  event: "model.task.prompt",
  status: "requested",
  detail: true,
  sensitivity: "content",
  taskId: "agent.message.compose",
  taskVersion: "1",
  promptFull: `你是辉夜，请自然回应邀请，并确认自己负责的物品。\n${history}`,
  promptVariables: [
    {
      variableName: "history",
      informationIds: ["inbound1-demo"],
      contentDigest: historyDigest,
    },
  ],
  informationId: "replyreq-demo",
  kind: "core.model.task.requested",
  references: [
    { relation: "core:uses-context", informationId: "inbound1-demo" },
  ],
});
information.info({
  event: "model.task.lifecycle",
  status: "completed",
  taskId: "agent.message.compose",
  providerId: "demo",
  modelId: "demo-model",
  durationMs: 1248,
});
information.info({
  event: "message.assistant",
  ...previewInformationContent(
    "好呀，我来带望远镜！🔭\n明天先看天气，再确认集合时间；如果云太多，就一起整理上次的观测笔记。",
  ),
  originatingModuleInstanceId: "composer-demo",
  informationId: "reply001-demo",
  kind: "core.message.assistant.text",
  references: [{ relation: "core:caused-by", informationId: "model001-demo" }],
});
information.info({
  event: "delivery.lifecycle",
  status: "delivered",
  adapterId: "napcat",
});
information.info({
  event: "person.fact.extracted",
  informationId: "person01-demo",
  kind: "core.person.fact.extracted",
  references: [{ relation: "core:caused-by", informationId: "factmdl1-demo" }],
});
information.debug({
  event: "person.fact.extracted",
  detail: true,
  sensitivity: "content",
  ...previewInformationContent(
    "虚构用户对天文观测感兴趣，愿意携带观测笔记参加小组活动。",
  ),
  informationId: "person01-demo",
  kind: "core.person.fact.extracted",
  references: [{ relation: "core:caused-by", informationId: "factmdl1-demo" }],
});
for (const status of ["completed", "empty", "failed"]) {
  information.debug({
    event: "memory.writeback.terminal",
    status,
    informationId: `write-${status}-demo`,
    kind: `memory.writeback.${status}`,
    references: [
      {
        relation: "core:status-of",
        informationId: `write-request-${status}-demo`,
      },
    ],
  });
}
information.info({
  event: "memory.association.completed",
  status: "empty",
  route: "message",
  method: "sparse-2gram",
  candidateCount: 0,
  reasonCodes: ["no-sparse-match"],
  informationId: "assoc002-demo",
  kind: "memory.association.completed",
  references: [{ relation: "core:caused-by", informationId: "query002-demo" }],
});
adapter.warn(
  {
    event: "napcat.connection.disconnected",
    adapterId: "napcat",
    connectivity: "disconnected",
    errorType: "ConnectionClosed",
  },
  "Adapter state updated",
);
information.error({
  event: "model.task.lifecycle",
  status: "failed",
  taskId: "agent.turn.plan",
  errorKind: "retryable",
  failureStage: "structured-output-parse",
  structuredOutputFailure: "invalid-json",
  attemptCount: 2,
});
await closeLogger(root);
