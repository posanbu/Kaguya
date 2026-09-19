/**
 * 默认源码及允许变量来自 prompt-declarations；可传入装配阶段预检的本地模板。
 * Prompt 正文由装配入口注入已加载的 default/local 模板，本文件不保留独立默认文本。
 * 功能概述：Heartflow 的独立结构化 Planner 契约、只读上下文选择器和纯 Prompt 编译器。
 * 主要职责：plannerActionSchema 严格限制动作及原因；plannerDecisionInformationKind 持久化唯一分派结果；
 * plannerContextSelector 复用 Composer 的同范围成功投递历史过滤与冻结记忆授权；compilePlannerPrompt
 * 选择器同时授权已持久化的任务上下文，恢复时复用首次请求，迟到消息不改变重放 Prompt。
 * 读取身份、规则、历史、记忆和全部冻结输入，输出带变量溯源的 route Prompt，只能引用宿主冻结候选，不允许生成原始目标 ID。
 * 代码库关系：Heartflow 调用通用 Model Task 并以 claim 竞争决策锁；Composer 仅处理获胜 message 意图。
 * 输入输出与副作用：模型只有 message/wait/silent 三个分支，故障原因由宿主写入；选择器只读账本，
 * Prompt 中的用户文本属于数据，不具有指令权限。原始 Prompt 与模型结果不写普通日志。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
 */
import { plannerTemplateDeclaration } from "../../prompt-declarations.js";
import {
  z,
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import { defineInformationKind, defineInformationSelector } from "@kaguya/sdk";
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import { turnMessageContextSelector } from "../message-composer/message-context.js";
import type { AgentIdentity } from "../message-composer/message-prompt.js";
import {
  assistantTextInformationKind,
  inboundTextInformationKind,
  turnContextCompletedInformationKind,
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
export type PlannerAction = z.infer<typeof plannerActionSchema>;
export const plannerDecisionInformationKind = defineInformationKind({
  kind: "agent.turn.plan.completed",
  displayName: "回合规划结果",
  description:
    "Planner 输出通过严格校验并获得决策锁后登记发言、等待或静默；Heartflow 只分派获胜结果，规划不可用时以静默闭合。",
  payloadSchema: z
    .object({
      gateInformationId: z.string().min(1),
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
    const turns = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:uses-context",
      direction: "outgoing",
      limit: 1000,
    });
    const turn = turns.find(
      (atom) =>
        atom.kind === turnContextCompletedInformationKind.kind &&
        atom.informationId === sourceAtom.payload.turnContextInformationId,
    );
    if (!turn) throw new Error("Planner requires its frozen turn");
    const payload: any =
      turnContextCompletedInformationKind.payloadSchema.parse(turn.payload);
    const source = payload.inputs.at(-1).source;
    // 仅构造选择器参数，不在账本提前发布 message intent。
    const selected = await turnMessageContextSelector.select({
      ledger,
      sourceAtom: {
        ...sourceAtom,
        payload: {
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
      },
    });
    // 重放必须复用首次 requested 的 Prompt 和原子顺序，避免迟到历史改变任务指纹。
    const requests = (
      await ledger.related({
        from: [sourceAtom.informationId],
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
  const histories = atoms.filter(
    (atom) =>
      !inputIds.has(atom.informationId) &&
      !memoryIds.has(atom.informationId) &&
      (atom.kind === inboundTextInformationKind.kind ||
        atom.kind === assistantTextInformationKind.kind),
  );
  const memories = atoms.filter((atom) => memoryIds.has(atom.informationId));
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
            text: atom.payload.text,
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
      content: JSON.stringify(memories.map((atom) => atom.payload.text)),
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
                senderId: string;
                sender?: { nickname?: string; card?: string };
                mentions?: { kind: string; id?: string }[];
                replyTo?: { platformMessageId: string };
              };
            },
            inputIndex: number,
          ) => ({
            inputIndex,
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
        backlog: payload.backlog,
        attempt: payload.attempt,
        totalWaitBudget: payload.totalWaitBudget,
      }),
      informationIds: [turn.informationId],
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
