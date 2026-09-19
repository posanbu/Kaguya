/**
 * 功能概述：第一方模板的唯一静态契约，显式声明归属、变量与组成关系。
 * 主要职责：messageTemplateDeclarations/plannerTemplateDeclaration/personFactTemplateDeclaration
 * 以及 expressionModulePromptTemplates 供 manifest、受限编译器与 Node 存储使用；正文全部来自 default/local 文件。
 * 代码库关系：消息编译器通过 key 获取已有模板输入，Node 仅通过已声明 templateId 定位 default/local 文件。
 * 输入输出与副作用：仅常量，无运行时用户、身份或记忆数据，也不执行文件操作。
 */
import type { ModulePromptTemplateDefinition } from "@kaguya/sdk";
const messageVariables = [
  "is_assistant",
  "occurred_at",
  "occurred_at_iso",
  "sender_name",
  "sender_id",
  "platform",
  "adapter_id",
  "destination",
  "message_id",
  "mentions",
  "reply_to",
  "content",
  "quoted_message",
  "self_account",
  "name",
] as const;
export const outerVariables = [
  "persona",
  "name",
  "aliases",
  "self_account",
  "scene",
  "current_time",
  "plan",
  "history",
  "memory",
  "turn",
] as const;

export const messageTemplateDeclarations = [
  {
    key: "main",
    fileStem: "message-composer",
    name: "message-composer",
    displayName: "消息编写主模板",
    description: "组合身份、会话历史、记忆与当前轮次，生成消息编写指令。",
    allowedVariables: outerVariables,
    allowedPartials: [],
    composes: [
      "message-composer.scene",
      "message-composer.plan",
      "message-composer.history",
      "message-composer.memory",
      "message-composer.turn",
    ],
  },
  {
    key: "plan",
    fileStem: "message-composer.plan",
    name: "plan",
    displayName: "消息表达意图",
    description: "组织 Planner 选中的话题、动作、指引和话题锚点。",
    allowedVariables: [
      "current_time",
      "topic",
      "reply_act",
      "guidance",
      "messages",
      ...messageVariables,
    ],
    allowedPartials: ["history-inbound"],
    composes: ["message-composer.history-inbound"],
  },
  {
    key: "history",
    fileStem: "message-composer.history",
    name: "history",
    displayName: "历史消息列表",
    description: "组织同一会话中的历史消息。",
    allowedVariables: ["messages", ...messageVariables],
    allowedPartials: ["history-inbound", "history-assistant"],
    composes: [
      "message-composer.history-inbound",
      "message-composer.history-assistant",
    ],
  },
  {
    key: "historyInbound",
    fileStem: "message-composer.history-inbound",
    name: "history-inbound",
    displayName: "历史入站消息",
    description: "展示一条用户历史消息或当前输入。",
    allowedVariables: messageVariables,
    allowedPartials: [],
    composes: [],
  },
  {
    key: "historyAssistant",
    fileStem: "message-composer.history-assistant",
    name: "history-assistant",
    displayName: "历史已发送消息",
    description: "展示机器人成功投递的历史消息。",
    allowedVariables: messageVariables,
    allowedPartials: [],
    composes: [],
  },
  {
    key: "memory",
    fileStem: "message-composer.memory",
    name: "memory",
    displayName: "记忆列表",
    description: "组织经过授权选择的记忆条目。",
    allowedVariables: ["items", "content"],
    allowedPartials: ["memory-item"],
    composes: ["message-composer.memory-item"],
  },
  {
    key: "memoryItem",
    fileStem: "message-composer.memory-item",
    name: "memory-item",
    displayName: "单条记忆",
    description: "格式化一个记忆条目。",
    allowedVariables: ["content"],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "quoted",
    fileStem: "message-composer.quoted",
    name: "quoted",
    displayName: "引用消息",
    description: "组织输入所引用的消息内容与标识。",
    allowedVariables: ["message", "message_id"],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "turn",
    fileStem: "message-composer.turn",
    name: "turn",
    displayName: "当前完整轮次",
    description: "组织冻结轮次的全部输入；引用内容由 quoted 模板预先生成。",
    allowedVariables: ["messages", ...messageVariables],
    allowedPartials: ["history-inbound"],
    composes: ["message-composer.history-inbound", "message-composer.quoted"],
  },
  {
    key: "scene",
    fileStem: "message-composer.scene",
    name: "scene",
    displayName: "对话场景与积压提示",
    description: "根据群聊或私聊及输入积压状态组织消息编写指引。",
    allowedVariables: [
      "is_group",
      "is_backlog",
      "oldest_input_age",
      "newest_input_age",
    ],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "conversationBackground",
    fileStem: "message-composer.conversation-background",
    name: "conversation-background",
    displayName: "会话人物背景",
    description: "补充当前会话的人物关系与称谓背景。",
    allowedVariables: ["conversation_background"],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "expressionHabits",
    fileStem: "message-composer.expression-habits",
    name: "expression-habits",
    displayName: "表达习惯参考",
    description: "将已选择的表达习惯限定为措辞参考。",
    allowedVariables: ["expression_habits"],
    allowedPartials: [],
    composes: [],
  },
] as const;
export const authorizedMessageTemplateDeclarations = [
  {
    key: "automatic",
    templateId: "message-composer.authorized-automatic",
    name: "authorized-automatic",
    displayName: "跨会话授权消息",
    description: "根据本轮已授权的要求生成跨会话消息正文。",
    allowedVariables: ["instruction", "background"],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "admin",
    templateId: "message-composer.authorized-admin",
    name: "authorized-admin",
    displayName: "管理员授权消息",
    description: "根据管理员批准的要求生成消息正文。",
    allowedVariables: ["instruction"],
    allowedPartials: [],
    composes: [],
  },
] as const;
export const messageModulePromptTemplates: readonly ModulePromptTemplateDefinition[] =
  [
    ...messageTemplateDeclarations.map((item) => ({
      ...item,
      templateId: item.fileStem,
    })),
    ...authorizedMessageTemplateDeclarations,
  ];
export const expressionTemplateDeclarations = [
  {
    key: "learn",
    fileStem: "expression.learn",
    templateId: "expression.learn",
    name: "expression-learn",
    displayName: "表达习惯学习",
    description: "从真人消息提取有证据支持的抽象表达习惯。",
    allowedVariables: ["context"],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "select",
    fileStem: "expression.select",
    templateId: "expression.select",
    name: "expression-select",
    displayName: "表达习惯选择",
    description: "依据冻结回合和消息意图选择合适的表达习惯。",
    allowedVariables: ["context"],
    allowedPartials: [],
    composes: [],
  },
] as const;
export const expressionModulePromptTemplates: readonly ModulePromptTemplateDefinition[] =
  expressionTemplateDeclarations;
export const plannerTemplateDeclaration: ModulePromptTemplateDefinition = {
  templateId: "heartflow.planner",
  name: "planner",
  displayName: "对话规划",
  description:
    "根据冻结会话上下文选择 message、wait 或 silent，不生成消息正文。",
  allowedVariables: [
    "current_time",
    "identity",
    "history",
    "memory",
    "turn",
    "conversation",
  ],
  allowedPartials: [],
  composes: [],
};
export const personFactTemplateDeclaration: ModulePromptTemplateDefinition = {
  templateId: "person-fact",
  name: "person-fact",
  displayName: "人物事实提取",
  description: "从候选证据提取人物事实。",
  allowedVariables: ["person_id", "name", "candidate"],
  allowedPartials: [],
  composes: [],
};

/** 所有第一方模板组的白名单；文件初始化和存储与模块声明共用此入口。 */
export const firstPartyPromptTemplateGroups = [
  messageModulePromptTemplates,
  [plannerTemplateDeclaration],
  [personFactTemplateDeclaration],
  expressionModulePromptTemplates,
] as const;
