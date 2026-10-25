/**
 * 声明独立 QQ 表情推断与选择模板，确保文件覆盖、管理界面和运行时使用相同契约。
 * 功能概述：第一方模板的唯一静态契约，显式声明归属、变量与组成关系。
 * 主要职责：消息、Light 与 Memory 模板声明
 * 及 QQ 表情模板 供 manifest、受限编译器与 Node 存储使用；正文全部来自 default/local 文件。
 * 代码库关系：消息编译器通过 key 获取已有模板输入，Node 仅通过已声明 templateId 定位 default/local 文件。
 * context_bootstrap 向 Light 和 Heavy 暴露冻结的证据可用性；人设仅定义角色表达，不作为现实关系来源。
 * 输入输出与副作用：仅常量，无运行时用户、身份或记忆数据，也不执行文件操作。
 */
/**
 * 声明独立 QQ 表情推断与选择模板，确保文件覆盖、管理界面和运行时使用相同契约。
 * 功能概述：第一方模板的唯一静态契约，显式声明归属、变量与组成关系。
 * 主要职责：消息、Light 与 Memory 模板声明
 * 及 QQ 表情模板 供 manifest、受限编译器与 Node 存储使用；正文全部来自 default/local 文件。
 * 代码库关系：消息编译器通过 key 获取已有模板输入，Node 仅通过已声明 templateId 定位 default/local 文件。
 * context_bootstrap 向 Light 和 Heavy 暴露冻结的证据可用性；人设仅定义角色表达，不作为现实关系来源。
 * 输入输出与副作用：仅常量，无运行时用户、身份或记忆数据，也不执行文件操作。
 */
import type { PromptResourceDefinition } from "@kaguya/prompt";
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
  "context_bootstrap",
  "persona",
  "behavior_policy",
  "platform_style",
  "name",
  "aliases",
  "self_account",
  "scene",
  "current_time",
  "global_context",
  "scope_context",
  "memory",
  "bootstrap",
] as const;

export const messageTemplateDeclarations = [
  {
    key: "main",
    fileStem: "heavy",
    name: "heavy",
    displayName: "消息编写主模板",
    description: "组合身份、双层原始事件上下文与记忆，生成消息编写指令。",
    allowedVariables: outerVariables,
    allowedPartials: [],
    composes: ["heavy.scene", "heavy.bootstrap", "heavy.memory"],
  },
  {
    key: "historyInbound",
    fileStem: "heavy.history-inbound",
    name: "history-inbound",
    displayName: "历史入站消息",
    description: "展示一条用户历史消息或当前输入。",
    allowedVariables: messageVariables,
    allowedPartials: [],
    composes: [],
  },
  {
    key: "historyAssistant",
    fileStem: "heavy.history-assistant",
    name: "history-assistant",
    displayName: "历史已发送消息",
    description: "展示机器人成功投递的历史消息。",
    allowedVariables: messageVariables,
    allowedPartials: [],
    composes: [],
  },
  {
    key: "memory",
    fileStem: "heavy.memory",
    name: "memory",
    displayName: "记忆列表",
    description: "组织经过授权选择的记忆条目。",
    allowedVariables: ["items", "content"],
    allowedPartials: ["memory-item"],
    composes: ["heavy.memory-item"],
  },
  {
    key: "memoryItem",
    fileStem: "heavy.memory-item",
    name: "memory-item",
    displayName: "单条记忆",
    description: "格式化一个记忆条目。",
    allowedVariables: ["content"],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "bootstrap",
    fileStem: "heavy.bootstrap",
    name: "bootstrap",
    displayName: "冷启动表达策略",
    description:
      "根据冻结的会话、人物与 Memory 证据状态约束未知信息的自然表达。",
    allowedVariables: ["bootstrap"],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "scene",
    fileStem: "heavy.scene",
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
    fileStem: "heavy.conversation-background",
    name: "conversation-background",
    displayName: "会话人物背景",
    description: "补充当前会话的人物关系与称谓背景。",
    allowedVariables: ["conversation_background"],
    allowedPartials: [],
    composes: [],
  },
] as const;
export const authorizedMessageTemplateDeclarations = [
  {
    key: "automatic",
    templateId: "heavy.authorized-automatic",
    name: "authorized-automatic",
    displayName: "跨会话授权消息",
    description: "根据本轮已授权的要求生成跨会话消息正文。",
    allowedVariables: ["instruction", "background"],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "admin",
    templateId: "heavy.authorized-admin",
    name: "authorized-admin",
    displayName: "管理员授权消息",
    description: "根据管理员批准的要求生成消息正文。",
    allowedVariables: ["instruction"],
    allowedPartials: [],
    composes: [],
  },
] as const;
export const heavyModulePromptTemplates: readonly ModulePromptTemplateDefinition[] =
  [
    ...messageTemplateDeclarations.map((item) => ({
      ...item,
      templateId: item.fileStem,
      mutability: "editable" as const,
    })),
    ...authorizedMessageTemplateDeclarations.map((item) => ({
      ...item,
      mutability: "editable" as const,
    })),
    {
      templateId: "heavy.behavior",
      name: "heavy-behavior",
      displayName: "消息编写通用行为",
      description: "真实性、安全、情绪理解和避免元叙述等平台无关规则。",
      allowedVariables: [],
      allowedPartials: [],
      composes: [],
      mutability: "editable" as const,
    },
    ...["default", "qq", "web"].map((platform) => ({
      templateId: `heavy.platform-style${platform === "default" ? "" : `-${platform}`}`,
      name: `heavy-platform-style-${platform}`,
      displayName: `消息表达风格（${platform}）`,
      description: `${platform} 平台的消息表达风格。`,
      allowedVariables: [],
      allowedPartials: [],
      composes: [],
      mutability: "editable" as const,
    })),
  ];
export const qqExpressionTemplateDeclarations = [
  {
    key: "learn",
    templateId: "qq-expression.learn",
    fileStem: "qq-expression.learn",
    name: "qq-expression-learn",
    displayName: "QQ 表情语义推断",
    description: "仅从聊天上下文推断表情用法。",
    allowedVariables: ["context"],
    allowedPartials: [],
    composes: [],
  },
  {
    key: "select",
    templateId: "qq-expression.select",
    fileStem: "qq-expression.select",
    name: "qq-expression-select",
    displayName: "QQ 表情选择",
    description: "按规划语境选择至多一个表情。",
    allowedVariables: ["context"],
    allowedPartials: [],
    composes: [],
  },
] as const;
export const qqExpressionModulePromptTemplates: readonly ModulePromptTemplateDefinition[] =
  qqExpressionTemplateDeclarations.map((d) => ({
    ...d,
    mutability: "editable" as const,
  }));

export const lightTemplateDeclaration: ModulePromptTemplateDefinition = {
  mutability: "editable",
  templateId: "light.decision",
  name: "light",
  displayName: "对话规划",
  description:
    "根据冻结会话上下文选择 message、wait 或 silent，不生成消息正文。",
  allowedVariables: [
    "context_bootstrap",
    "current_time",
    "identity",
    "global_context",
    "scope_context",
    "decision_state",
    "memory",
    "conversation",
    "platform_policy",
    "bootstrap",
    "bootstrap_policy",
  ],
  allowedPartials: [],
  composes: [],
};
export const lightBootstrapPolicyDeclaration: ModulePromptTemplateDefinition = {
  mutability: "editable",
  templateId: "light.bootstrap-policy",
  name: "router-bootstrap-policy",
  displayName: "冷启动参与策略",
  description:
    "依据确定性的 bootstrap 投影决定是否询问、承认未知或进入正常交流。",
  allowedVariables: [],
  allowedPartials: [],
  composes: [],
};
export const lightPlatformPolicyDeclarations: readonly ModulePromptTemplateDefinition[] =
  ["default", "qq", "web"].map((platform) => ({
    mutability: "editable" as const,
    templateId: `light.platform-policy${platform === "default" ? "" : `-${platform}`}`,
    name: `router-platform-policy-${platform}`,
    displayName: `平台参与策略（${platform}）`,
    description: `${platform} 平台的参与和静默策略。`,
    allowedVariables: [],
    allowedPartials: [],
    composes: [],
  }));

export const identityNameTemplateDeclaration: PromptResourceDefinition = {
  templateId: "memory.identity.name",
  name: "identity-name",
  displayName: "辉夜名称",
  description: "工作区级 Agent 主名称。",
  content: "",
  allowedVariables: [],
  allowedPartials: [],
  composes: [],
  mutability: "editable",
};
export const identityAliasesTemplateDeclaration: PromptResourceDefinition = {
  templateId: "memory.identity.aliases",
  name: "identity-aliases",
  displayName: "辉夜别名",
  description: "工作区级 Agent 别名，每行一个。",
  content: "",
  allowedVariables: [],
  allowedPartials: [],
  composes: [],
  mutability: "editable",
};
export const identityPersonaTemplateDeclaration: PromptResourceDefinition = {
  templateId: "memory.identity.persona",
  name: "identity-persona",
  displayName: "辉夜身份设定",
  description:
    "工作区级角色身份与表达性格；虚构背景不是现实经历或人物关系证据。",
  content: "",
  allowedVariables: [],
  allowedPartials: [],
  composes: [],
  mutability: "editable",
};
export const nativeMemoryTemplateDeclaration: ModulePromptTemplateDefinition = {
  mutability: "editable",
  templateId: "memory.native.form",
  name: "native-memory-form",
  displayName: "记忆形成与整理",
  description: "从冻结证据形成分层记忆和显式关系。",
  allowedVariables: ["context"],
  allowedPartials: [],
  composes: [],
};

/** 所有第一方模板组的白名单；文件初始化和存储与模块声明共用此入口。 */
export const firstPartyPromptTemplateGroups = [
  heavyModulePromptTemplates,
  [
    lightTemplateDeclaration,
    lightBootstrapPolicyDeclaration,
    ...lightPlatformPolicyDeclarations,
  ],
  [
    identityNameTemplateDeclaration,
    identityAliasesTemplateDeclaration,
    identityPersonaTemplateDeclaration,
  ],
  qqExpressionModulePromptTemplates,
  [nativeMemoryTemplateDeclaration],
] as const;
