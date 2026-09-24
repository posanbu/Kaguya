/**
 * composition 兼容可选 tone（neutral/humorous/teasing），旧快照继续有效；缺失时表情插件保守禁用。
 * memory 变量携带来源类型和原文 ID，人工录入与运行时聊天观测在规划输入中可区分。
 * context_bootstrap 显式说明本轮证据缺口，避免把身份解析或角色设定误当作既有关系。
 * 默认源码及允许变量来自 prompt-declarations；可传入装配阶段预检的本地模板。
 * Prompt 正文由装配入口注入已加载的 default/local 模板，本文件不保留独立默认文本。
 * 功能概述：Heartflow 的独立结构化 Planner 契约、只读上下文选择器和纯 Prompt 编译器。
 * 主要职责：plannerActionSchema 严格限制动作及原因，plannerActionSchemaForTurn 为新任务收紧焦点范围与等待预算；plannerDecisionInformationKind 持久化唯一分派结果；
 * plannerContextSelector 复用 Composer 的同范围成功投递历史过滤与冻结记忆授权；compilePlannerPrompt
 * 选择器同时授权已持久化的任务上下文，恢复时复用首次请求，迟到消息不改变重放 Prompt。
 * 读取身份、规则、历史、记忆和全部冻结输入，提供稳定说话人键、通知事实、可用动作及经成功回执链核验的引用正文。
 * 历史与记忆分别受 12000/4000 字预算约束；引用完整来源加入 turn 变量溯源，缺失或冲突引用明确标为 unavailable。
 * 只能引用宿主冻结候选，不允许生成原始目标 ID；输入正文保持完整，兴趣证据仍来自普通 memory 数据。
 * 代码库关系：Heartflow 调用通用 Model Task 并以 claim 竞争决策锁；Composer 仅处理获胜 message 意图。
 * 输入输出与副作用：模型只有 message/wait/silent 三个分支，故障原因由宿主写入；选择器只读账本，
 * Prompt 中的用户文本属于数据，不具有指令权限。原始 Prompt 与模型结果不写普通日志。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
 */
import { contextBootstrapVariable } from "../context-bootstrap.js";
import { plannerTemplateDeclaration } from "../../prompt-declarations.js";
import { selectPlatformPromptResource } from "@kaguya/prompt";
import {
  z,
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import { defineInformationKind, defineInformationSelector } from "@kaguya/sdk";
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import { selectFrozenTurnMessageContext } from "../message-composer/message-context.js";
import {
  resolveMessageQuote,
  sameMessageTarget,
  beforeQuoteCutoff,
} from "../message-composer/message-quote.js";
import { fitHistoryBudget } from "../message-composer/message-prompt.js";
import type { AgentIdentity } from "../message-composer/message-prompt.js";
import {
  assistantTextInformationKind,
  inboundTextInformationKind,
  turnContextCompletedInformationKind,
  normalizeTurnBootstrap,
} from "../information-kinds.js";
import { formatZonedInstant } from "../temporal-context.js";

import {
  plannerTargetSchema,
  conversationContextInformationKind,
} from "../message-authorization.js";

export const PLANNER_TASK_ID = "agent.turn.plan";
const focusInputIndexesSchema = z
  .array(z.number().int().nonnegative())
  .min(1)
  .max(3)
  .superRefine((indexes, context) => {
    if (new Set(indexes).size !== indexes.length)
      context.addIssue({
        code: "custom",
        message: "Composition focusInputIndexes must be unique",
      });
  });
const plannerCompositionShape = {
  focusInputIndexes: focusInputIndexesSchema,
  topic: z.string().trim().min(1).max(200),
  replyAct: z.string().trim().min(1).max(120),
};
export const plannerCompositionSchema = z.union([
  z
    .object({
      ...plannerCompositionShape,
      tone: z.enum(["neutral", "humorous", "teasing"]),
    })
    .strict(),
  z
    .object({
      ...plannerCompositionShape,
      tone: z.enum(["neutral", "humorous", "teasing"]),
      guidance: z.string().trim().min(1).max(500),
    })
    .strict(),
  z.object(plannerCompositionShape).strict(),
  z
    .object({
      ...plannerCompositionShape,
      guidance: z.string().trim().min(1).max(500),
    })
    .strict(),
]);
export const plannerActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("message"),
      reason: z.enum(["respond", "contribute"]),
      target: plannerTargetSchema.default({ kind: "current" }),
      composition: plannerCompositionSchema,
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
/** 本轮模型任务只接受预算内动作与有效焦点；持久化动作 Kind 继续使用稳定的通用 schema。 */
export function plannerActionSchemaForTurn(turn: {
  readonly inputs: readonly unknown[];
  readonly attempt: number;
  readonly totalWaitBudget: number;
}) {
  if (turn.inputs.length === 0)
    throw new Error("Planner requires at least one frozen input");
  const focusInputIndexes = z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(turn.inputs.length - 1),
    )
    .min(1)
    .max(Math.min(3, turn.inputs.length))
    .refine(
      (indexes) => new Set(indexes).size === indexes.length,
      "Composition focusInputIndexes must be unique",
    );
  const composition = z.union([
    plannerCompositionSchema.options[0].extend({ focusInputIndexes }),
    plannerCompositionSchema.options[1].extend({ focusInputIndexes }),
    plannerCompositionSchema.options[2].extend({ focusInputIndexes }),
    plannerCompositionSchema.options[3].extend({ focusInputIndexes }),
  ]);
  const message = plannerActionSchema.options[0].extend({ composition });
  return turn.attempt < turn.totalWaitBudget
    ? z.discriminatedUnion("action", [
        message,
        plannerActionSchema.options[1],
        plannerActionSchema.options[2],
      ])
    : z.discriminatedUnion("action", [message, plannerActionSchema.options[2]]);
}

export type PlannerAction = z.infer<typeof plannerActionSchema>;
export const plannerDecisionInformationKind = defineInformationKind({
  kind: "agent.turn.plan.completed",
  displayName: "回合规划结果",
  description:
    "Planner 输出通过严格校验并获得决策锁后登记发言、等待或静默；Heartflow 只分派获胜结果，规划不可用时以静默闭合。",
  payloadSchema: z
    .object({
      turnContextInformationId: z.string().min(1),
      action: z.union([
        plannerActionSchema,
        z
          .object({
            action: z.literal("silent"),
            reason: z.enum(["planner-unavailable", "wait-budget-exhausted"]),
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
      targetKinds: ["agent.turn.claimed"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "turn.plan",
      action: payload.action.action,
      reason: payload.action.reason,
    }),
  },
});

export const plannerContextSelector = defineInformationSelector({
  selectorId: "agent.heartflow.planner-context",
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
    if (!turn) throw new Error("Planner requires its frozen turn");
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
        composition: {
          focusInformationIds: [payload.inputs.at(-1).informationId],
          topic: "Planner context selection",
          replyAct: "select context",
        },
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
        atom.payload.taskId === PLANNER_TASK_ID,
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

export function compilePlannerPrompt(
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
  // 先给最新历史分配预算，再按时间顺序展示，避免较早长消息挤掉最新上下文。
  let remainingHistory = 12_000;
  const historyText = new Map(
    [...histories].reverse().map((atom) => {
      const text = Array.from(String(atom.payload.text)).slice(
        0,
        remainingHistory,
      );
      remainingHistory -= text.length;
      return [atom.informationId, text.join("")] as const;
    }),
  );
  // 各条来源都有展示机会，单条长原文不能吞掉后续角色兴趣或参与者证据。
  const memoryQuota = Math.floor(4_000 / Math.max(1, memories.length));
  const frozenInputs: DeepReadonly<InformationAtom>[] = payload.inputs.map(
    (input: any) => ({
      informationId: input.informationId,
      kind: inboundTextInformationKind.kind,
      occurredAt: input.occurredAt,
      source: turn.source,
      payload: { text: input.text, source: input.source },
      references: [],
    }),
  );
  const quoteAtoms = [
    ...atoms.filter((atom) => !inputIds.has(atom.informationId)),
    ...frozenInputs,
  ];
  const quoteProvenance = new Set<string>();
  const quotedInputs = frozenInputs.map((input) => {
    const source = inboundTextInformationKind.payloadSchema.parse(
      input.payload,
    ).source;
    const id = source.replyTo?.platformMessageId;
    if (!id) return null;
    const quote = resolveMessageQuote(
      quoteAtoms,
      id,
      payload.source,
      payload.asOf,
    );
    if (!quote) return { status: "unavailable", platformMessageId: id };
    for (const atom of quote.provenance)
      quoteProvenance.add(atom.informationId);
    const quotedSource = quote.message.payload.source as any;
    return {
      status: "resolved",
      platformMessageId: id,
      sourceInformationId: quote.message.informationId,
      role: quote.message.kind,
      speakerKey:
        quote.message.kind === assistantTextInformationKind.kind
          ? "self"
          : `speaker:${quotedSource.senderId}`,
      speaker:
        quote.message.kind === assistantTextInformationKind.kind
          ? identity.name
          : (quotedSource.sender?.card ??
            quotedSource.sender?.nickname ??
            quotedSource.senderId),
      text: quote.message.payload.text,
    };
  });
  const conversation = atoms.find(
    (a) =>
      a.kind === conversationContextInformationKind.kind &&
      a.references.some(
        (r) =>
          r.relation === "core:uses-context" &&
          r.informationId === turn.informationId,
      ),
  );
  const values = [
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
      name: "history",
      content: JSON.stringify(
        histories.map((atom) => {
          const source = (atom.payload as any).source ?? {};
          const occurredAt = formatZonedInstant(
            atom.occurredAt,
            identity.timeZone,
          );
          return {
            role: atom.kind,
            text: historyText.get(atom.informationId),
            truncated:
              historyText.get(atom.informationId) !== String(atom.payload.text),
            speakerKey:
              atom.kind === assistantTextInformationKind.kind
                ? "self"
                : `speaker:${source.senderId}`,
            occurredAt: occurredAt.iso,
            localTime: occurredAt.local,
            speaker:
              atom.kind === assistantTextInformationKind.kind
                ? identity.name
                : (source.sender?.card ??
                  source.sender?.nickname ??
                  source.senderId),
            platformMessageId: source.platformMessageId ?? null,
            replyTo: source.replyTo?.platformMessageId ?? null,
          };
        }),
      ),
      informationIds: histories.map((atom) => atom.informationId),
    },
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
    {
      name: "turn",
      content: JSON.stringify({
        inputs: payload.inputs.map(
          (
            input: {
              text: string;
              occurredAt: string;
              source: {
                platformMessageId: string;
                selfId?: string;
                senderId: string;
                sender?: { nickname?: string; card?: string };
                mentions?: { kind: string; id?: string }[];
                replyTo?: { platformMessageId: string; senderId?: string };
              };
            },
            inputIndex: number,
          ) => ({
            inputIndex,
            platformMessageId: input.source.platformMessageId,
            speakerKey: `speaker:${input.source.senderId}`,
            mentionedSelf:
              input.source.selfId !== undefined &&
              (input.source.mentions ?? []).some(
                (mention) =>
                  mention.kind === "user" && mention.id === input.source.selfId,
              ),
            repliedToSelf:
              input.source.selfId !== undefined &&
              input.source.replyTo?.senderId === input.source.selfId,
            quotedMessage: quotedInputs[inputIndex],
            text: input.text,
            occurredAt: input.occurredAt,
            localTime: formatZonedInstant(input.occurredAt, identity.timeZone)
              .local,
            speaker:
              input.source.sender?.card ??
              input.source.sender?.nickname ??
              input.source.senderId,
            mentions: input.source.mentions ?? [],
            replyTo: input.source.replyTo?.platformMessageId ?? null,
          }),
        ),
        observation: {
          isPrivate: payload.isPrivate,
          isGroup: payload.isGroup,
          focusActive: payload.focusActive ?? false,
        },
        availableActions:
          payload.attempt < payload.totalWaitBudget
            ? ["message", "wait", "silent"]
            : ["message", "silent"],
        remainingWaits: Math.max(0, payload.totalWaitBudget - payload.attempt),
        backlog: payload.backlog,
        attempt: payload.attempt,
        totalWaitBudget: payload.totalWaitBudget,
      }),
      informationIds: [...new Set([turn.informationId, ...quoteProvenance])],
    },
  ];
  return createPromptTemplateRenderer({
    kind: "route",
    templateId: "kaguya.planner.zh-CN/v1",
    main: {
      ...plannerTemplateDeclaration,
      content: promptTemplate,
    },
  })(values);
}
