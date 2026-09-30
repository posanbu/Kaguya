/**
 * Light 只判断参与动作与必要目标。
 * memory 变量携带原文来源 ID，与当前聊天输入在规划时区分。
 * context_bootstrap 显式说明本轮证据缺口，避免把身份解析或角色设定误当作既有关系。
 * 默认源码及允许变量来自 prompt-declarations；可传入装配阶段预检的本地模板。
 * Prompt 正文由装配入口注入已加载的 default/local 模板，本文件不保留独立默认文本。
 * 功能概述：Router 的独立结构化 Light 契约、只读上下文选择器和纯 Prompt 编译器。
 * 主要职责：lightActionSchema 严格限制动作及原因，lightActionSchemaForTurn 为新任务收紧等待预算；lightDecisionInformationKind 持久化唯一分派结果；
 * lightContextSelector 复用 Heavy 的同范围成功投递历史过滤与冻结记忆授权；compileLightPrompt
 * 选择器同时授权已持久化的任务上下文，恢复时复用首次请求，迟到消息不改变重放 Prompt。
 * 读取身份、规则、历史、记忆和全部冻结输入，提供稳定说话人键、通知事实、可用动作及经成功回执链核验的引用正文。
 * 运行时读取冻结的原始 Memory 双层上下文。
 * 只能引用宿主冻结候选，不允许生成原始目标 ID；输入正文保持完整，兴趣证据仍来自普通 memory 数据。
 * 代码库关系：Router 调用通用 Model Task 并以 claim 竞争决策锁；Heavy 仅处理获胜 message 意图。
 * 输入输出与副作用：模型只有 message/wait/silent 三个分支，故障原因由宿主写入；选择器只读账本，
 * Prompt 中的用户文本属于数据，不具有指令权限。原始 Prompt 与模型结果不写普通日志。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
 */
import { contextBootstrapVariable } from "../context-bootstrap.js";
import {
  appendPersonProfilesToPrompt,
  frozenSpeakerName,
} from "../person-profile.js";
import { lightTemplateDeclaration } from "../../prompt-declarations.js";
import { selectPlatformPromptResource } from "@kaguya/prompt";
import {
  z,
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import { defineInformationKind, defineInformationSelector } from "@kaguya/sdk";
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import { selectFrozenTurnMessageContext } from "../heavy/message-context.js";
import {
  resolveMessageQuote,
  sameMessageTarget,
  beforeQuoteCutoff,
} from "../heavy/message-quote.js";
import { fitHistoryBudget } from "../heavy/message-prompt.js";
import type { AgentIdentity } from "../heavy/message-prompt.js";
import {
  assistantTextInformationKind,
  inboundTextInformationKind,
  turnContextCompletedInformationKind,
  normalizeTurnBootstrap,
} from "../information-kinds.js";
import { formatZonedInstant } from "../temporal-context.js";
import { frozenRawContextInformationKind } from "./raw-context.js";

import {
  lightTargetSchema,
  conversationContextInformationKind,
} from "../message-authorization.js";

export const LIGHT_TASK_ID = "agent.light.decide";
export const lightActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("message"),
      reason: z.enum(["respond", "contribute"]),
      target: lightTargetSchema.default({ kind: "current" }),
    })
    .strict(),
  z
    .object({
      action: z.literal("wait"),
      reason: z.enum(["await-more-context", "avoid-interruption"]),
      waitSeconds: z.number().int().min(5).max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal("silent"),
      reason: z.enum([
        "no-response-needed",
        "already-addressed",
        "avoid-interruption",
        "topic-expired",
      ]),
    })
    .strict(),
]);
/** 校验参与动作与等待预算。 */
export function lightActionSchemaForTurn(turn: {
  readonly inputs: readonly unknown[];
  readonly attempt: number;
  readonly totalWaitBudget: number;
}) {
  if (turn.inputs.length === 0)
    throw new Error("Light requires at least one frozen input");
  return turn.attempt < turn.totalWaitBudget
    ? lightActionSchema
    : z.discriminatedUnion("action", [
        lightActionSchema.options[0],
        lightActionSchema.options[2],
      ]);
}

export type LightAction = z.infer<typeof lightActionSchema>;
export const lightDecisionInformationKind = defineInformationKind({
  kind: "agent.light.decision.completed",
  displayName: "回合规划结果",
  description:
    "Light 输出通过严格校验并获得决策锁后登记发言、等待或静默；Router 只分派获胜结果，规划不可用时以静默闭合。",
  payloadSchema: z
    .object({
      turnContextInformationId: z.string().min(1),
      action: z.union([
        lightActionSchema,
        z
          .object({
            action: z.literal("silent"),
            reason: z.enum(["light-unavailable", "wait-budget-exhausted"]),
          })
          .strict(),
      ]),
    })
    .strict(),
  references: {
    "core:uses-context": { required: true, multiple: false },
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: ["agent.router.turn.claimed"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "light.decision",
      action: payload.action.action,
      reason: payload.action.reason,
    }),
  },
});

export const lightContextSelector = defineInformationSelector({
  selectorId: "agent.router.light-context",
  select: async ({ sourceAtom, ledger }) => {
    const turns =
      sourceAtom.kind === turnContextCompletedInformationKind.kind
        ? [sourceAtom]
        : await ledger.related({
            from: [sourceAtom.informationId],
            relation: "core:uses-context",
            direction: "outgoing",
            limit: 1000,
          });
    const turn = turns.find(
      (atom) => atom.kind === turnContextCompletedInformationKind.kind,
    );
    if (!turn) throw new Error("Light requires its frozen turn");
    const payload: any =
      turnContextCompletedInformationKind.payloadSchema.parse(turn.payload);
    const source = payload.inputs.at(-1).source;
    const selected = await selectFrozenTurnMessageContext({
      ledger,
      sourceInformationId: turn.informationId,
      turn,
      intent: {
        target: {
          adapterId: source.adapterId,
          platform: source.platform,
          destination: source.destination,
        },
        turn: {
          candidateInformationId: payload.candidateInformationId,
          claimInformationId: payload.claimInformationId,
          contextInformationId: turn.informationId,
        },
        memoryInformationIds: payload.memory ?? [],
      },
    });
    // 重放必须复用首次 requested 的 Prompt 和原子顺序，避免迟到历史改变任务指纹。
    const gates = await ledger.find({
      kinds: ["agent.attention.arousal.completed"],
      payloadContains: {
        candidateInformationId: payload.candidateInformationId,
        outcome: "observe",
      },
      registrationOrder: true,
      order: "desc",
      limit: 1,
    });
    const requests = (
      await ledger.related({
        from: [turn.informationId],
        relation: "core:caused-by",
        direction: "incoming",
        limit: 1000,
      })
    ).filter(
      (atom) =>
        atom.kind === "core.model.task.requested" &&
        atom.payload.taskId === LIGHT_TASK_ID,
    );
    const persisted = (
      await Promise.all(
        requests.map((atom) =>
          ledger.related({
            from: [atom.informationId],
            relation: "core:uses-context",
            direction: "outgoing",
            limit: 1000,
          }),
        ),
      )
    ).flat();
    return [
      ...new Set([
        ...selected,
        turn.informationId,
        ...gates.map((atom) => atom.informationId),
        ...requests.map((atom) => atom.informationId),
        ...persisted.map((atom) => atom.informationId),
      ]),
    ];
  },
});

export function compileLightPrompt(
  identity: AgentIdentity,
  atoms: readonly DeepReadonly<InformationAtom>[],
  turn: DeepReadonly<InformationAtom>,
  promptTemplate: string,
  platformPolicies?: Readonly<Record<"default" | "qq" | "web", string>>,
  bootstrapPolicy = "",
): CompiledPrompt {
  const payload: any = turnContextCompletedInformationKind.payloadSchema.parse(
    turn.payload,
  );
  const personProfiles = payload.personProfiles ?? [];
  const personNames = payload.personNames ?? [];
  const currentTime = formatZonedInstant(
    payload.backlog.evaluatedAt,
    identity.timeZone,
  );
  const inputIds = new Set(
    payload.inputs.map(
      (input: { informationId: string }) => input.informationId,
    ),
  );
  const memoryIds = new Set<string>(payload.memory ?? []);
  const histories = fitHistoryBudget(
    atoms.filter(
      (atom) =>
        sameMessageTarget(atom.payload.source, payload.source) &&
        beforeQuoteCutoff(atom, payload.asOf) &&
        !inputIds.has(atom.informationId) &&
        !memoryIds.has(atom.informationId) &&
        (atom.kind === inboundTextInformationKind.kind ||
          atom.kind === assistantTextInformationKind.kind),
    ),
  );
  const memories = [...memoryIds]
    .map((id) => atoms.find((atom) => atom.informationId === id))
    .filter((atom) => atom !== undefined)
    .slice(0, 8);
  const memoryQuota = Math.floor(4_000 / Math.max(1, memories.length));
  const conversation = atoms.find(
    (a) =>
      a.kind === conversationContextInformationKind.kind &&
      a.references.some(
        (r) =>
          r.relation === "core:uses-context" &&
          r.informationId === turn.informationId,
      ),
  );
  let values = [
    contextBootstrapVariable(turn, histories, memories),
    {
      name: "bootstrap_policy",
      content: bootstrapPolicy,
      informationIds: [],
    },
    {
      name: "bootstrap",
      content: JSON.stringify(
        normalizeTurnBootstrap(
          turn.payload as Readonly<Record<string, unknown>>,
        ),
      ),
      informationIds: [turn.informationId],
    },
    {
      name: "platform_policy",
      content: platformPolicies
        ? selectPlatformPromptResource(
            platformPolicies,
            payload.source.platform,
          )
        : "",
      informationIds: [turn.informationId],
    },
    {
      name: "current_time",
      content: JSON.stringify(currentTime),
      informationIds: [turn.informationId],
    },
    {
      name: "conversation",
      content: JSON.stringify(conversation?.payload ?? {}),
      informationIds: conversation ? [conversation.informationId] : [],
    },
    { name: "identity", content: JSON.stringify(identity), informationIds: [] },
    {
      name: "memory",
      content: JSON.stringify(
        memories.map((atom) => ({
          sourceKind: atom.kind,
          sourceInformationId: atom.informationId,
          sourceType: atom.payload.sourceType,
          occurredAt: atom.occurredAt,
          originalSourceInformationId: atom.payload.originalSourceInformationId,
          text: Array.from(String(atom.payload.text))
            .slice(0, memoryQuota)
            .join(""),
          truncated: Array.from(String(atom.payload.text)).length > memoryQuota,
        })),
      ),
      informationIds: memories.map((atom) => atom.informationId),
    },
  ];
  const raw = atoms.find(
    (atom) =>
      atom.kind === frozenRawContextInformationKind.kind &&
      atom.payload.turnInformationId === turn.informationId,
  );
  if (!raw) throw new Error("Light requires frozen raw Memory context");
  const frozen = frozenRawContextInformationKind.payloadSchema.parse(
    raw.payload,
  );
  values = [
    ...values,
    {
      name: "global_context",
      content: frozen.global.text,
      informationIds: [raw.informationId],
    },
    {
      name: "scope_context",
      content: frozen.currentScope.text,
      informationIds: [raw.informationId],
    },
    {
      name: "decision_state",
      content: JSON.stringify({
        availableActions:
          payload.attempt < payload.totalWaitBudget
            ? ["message", "wait", "silent"]
            : ["message", "silent"],
        attempt: payload.attempt,
        totalWaitBudget: payload.totalWaitBudget,
        observation: {
          isPrivate: payload.isPrivate,
          isGroup: payload.isGroup,
          focusActive: payload.focusActive ?? false,
        },
        backlog: payload.backlog,
      }),
      informationIds: [turn.informationId],
    },
  ];
  const prompt = createPromptTemplateRenderer({
    kind: "route",
    templateId: "kaguya.light.zh-CN",
    main: {
      ...lightTemplateDeclaration,
      content: promptTemplate,
    },
  })(values);
  return appendPersonProfilesToPrompt(
    prompt,
    payload.personProfiles ?? [],
    atoms,
    personNames,
  );
}
