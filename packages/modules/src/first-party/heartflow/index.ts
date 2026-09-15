/**
 * manifest 声明 Planner 模板；调用 compilePlannerPrompt 时传入装配阶段加载的覆盖。
 * settings schema 的公开中文元数据供管理表单使用，运行时与保存共用约束。
 * 管理端批准的跨会话 candidate 由宿主直接认领，不再触发 Planner；其 delivery 仍使用本模块统一 turn 终态。
 * Selector 只遍历开放 candidate 及最近 claim；恢复旧积压时每 scope 只推进一次合并观察。
 * 在线 Heartflow 编排器。所有推进都由可重放 Information 事实驱动；模块不保存
 * per-chat 状态，也不依赖订阅安装顺序。
 * createHeartflowModule 注入投递/模型失败 kind，返回声明订阅的模块；settings schema
 * 校验频率与安全策略。state/memory selector 从账本读取因果链及记忆，冻结完整输入。
 * Planner 重放沿已持久化请求复用 Prompt 和上下文选择，防止迟到历史触发第二次模型任务。
 * 宿主 conversation 能力冻结背景和候选；跨会话获胜决策交给 route 复核，失败关闭当前 turn，不回退发送。
 * dispatchDecision 仅将独立 Planner 的获胜 message 结果按 claim 注册一次意图，末条输入决定目标；
 * turn 标识及引用保留完整冻结上下文，正文生成交给 composer。defer/ignore 与失败路径
 * 写入等待或终态；registerOnce/commitTerminal 保证重放幂等，模型 I/O 经宿主 capability 执行，平台 I/O 由 delivery 层负责。
 * 展示契约：Manifest 直接提供中文名称、摘要及输入输出职责，供 Inspection 与 WebUI 展示。
 */
import { activeFocus, focusOpened } from "../attention-focus/facts.js";
import { plannerTemplateDeclaration } from "../../prompt-declarations.js";
import { scopeOf } from "../heartbeat/observation.js";
import {
  type MessageAuthorization,
  conversationContextInformationKind,
} from "../message-authorization.js";
import {
  compilePlannerPrompt,
  plannerActionSchema,
  plannerContextSelector,
  plannerDecisionInformationKind,
  PLANNER_TASK_ID,
} from "./planner.js";
import type {
  AgentIdentity,
  ModelTaskCapability,
} from "../message-composer/index.js";
import type { ModuleCapability } from "@kaguya/sdk";
import { createCognitionMemorySelector } from "../memory-cognition/index.js";
import type { CognitionIdentity } from "@kaguya/memory";

import {
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  z,
} from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  onInformation,
  type InformationKindDefinition,
  type InformationModuleHandlerContext,
  type InformationSelectorLedger,
} from "@kaguya/sdk";
import { MEMORY_RETRIEVAL_STRATEGY_ID } from "@kaguya/memory";

import {
  observationWakeInformationKind,
  inboundTextInformationKind,
  personContextCompletedInformationKind,
  messageIntentRequestedInformationKind,
  attentionArousalCompletedInformationKind,
  turnCandidateInformationKind,
  turnClaimedInformationKind,
  turnCompletedInformationKind,
  turnContextCompletedInformationKind,
  turnDecisionSupersededInformationKind,
  turnDecisionInterruptedInformationKind,
  turnFailedInformationKind,
  turnSilentInformationKind,
  turnStartedInformationKind,
  turnSupersededInformationKind,
  turnInterruptedInformationKind,
  turnWaitingInformationKind,
  waitRequestedInformationKind,
  type AttentionArousalPayload,
} from "../information-kinds.js";

type AnyKind = InformationKindDefinition<string, any>;

export interface CreateHeartflowModuleOptions {
  readonly modelTaskCapability: ModuleCapability<ModelTaskCapability>;
  readonly messageAuthorizationCapability?: ModuleCapability<MessageAuthorization>;
  readonly agentIdentity: AgentIdentity;
  readonly plannerTemplate?: string;
  readonly cognitionIdentity?: CognitionIdentity;
  readonly deliveryDeliveredInformationKind: AnyKind;
  readonly deliveryFailedInformationKind: AnyKind;
  readonly modelTaskFailedInformationKind: AnyKind;
  readonly modelTaskCancelledInformationKind: AnyKind;
  readonly modelTaskRequestedInformationKind?: AnyKind;
  readonly executionExhaustedInformationKind: AnyKind;
}

export const heartflowSettingsSchema = z
  .object({
    botNames: z.array(z.string().trim().min(1)).meta({
      title: "机器人名称",
      description: "由当前 Profile 身份提供，此处仅保留全局文件中的值。",
      public: true,
      readOnly: true,
    }),
    groupFrequency: z.number().min(0).max(1).meta({
      title: "群聊回复频率",
      description: "群聊参与频率，范围为 0 到 1。",
      public: true,
      default: 1,
    }),
    privateFrequency: z.number().min(0).max(1).meta({
      title: "私聊回复频率",
      description: "私聊参与频率，范围为 0 到 1。",
      public: true,
      default: 1,
    }),
    focusFrequencyMultiplier: z.number().min(0).max(4).default(1).meta({
      title: "Focus 发言频率倍率",
      description: "输入具体数值；在基础或动态频率之后应用，最终不超过 1。",
      public: true,
      default: 1,
    }),
    dynamicFrequencyEnabled: z.boolean().default(false).meta({
      title: "启用动态发言频率",
      description: "按平台、会话和本地时间段覆盖基础频率。",
      public: true,
      default: false,
    }),
    dynamicFrequencyRules: z
      .array(
        z
          .object({
            platform: z.string().default(""),
            itemId: z.string().default(""),
            chatType: z.enum(["group", "private"]),
            time: z.string().default(""),
            value: z.number().min(0).max(1),
          })
          .strict(),
      )
      .default([
        {
          platform: "",
          itemId: "",
          chatType: "group",
          time: "00:00-08:59",
          value: 0.8,
        },
        {
          platform: "",
          itemId: "",
          chatType: "group",
          time: "09:00-18:59",
          value: 1,
        },
      ])
      .meta({
        title: "动态频率规则",
        description: "具体会话优先；支持跨午夜时间段，未命中则回退基础频率。",
        public: true,
      }),
    muted: z.boolean().meta({
      title: "静默模式",
      description: "开启后抑制主动回复。",
      public: true,
      default: false,
    }),
    focusIdleMs: z.number().int().min(1000).max(3600000).default(120000).meta({
      title: "关注空闲期限",
      description: "群聊直接唤醒或成功参与后的租约时长，单位毫秒。",
      public: true,
      default: 120000,
    }),
    staleAfterMs: z.number().int().min(0).meta({
      title: "积压分类阈值",
      description:
        "最近一条输入超过此年龄时标记为积压并交由 Planner 判断，单位毫秒。",
      public: true,
      default: 120000,
    }),
    plannerInterruptMaxConsecutiveCount: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(2)
      .meta({
        title: "规划器连续打断上限",
        description: "同一轮新消息最多使规划器重新思考几次；0 表示关闭。",
        public: true,
        default: 2,
      }),
  })
  .strict();
export type HeartflowSettings = z.infer<typeof heartflowSettingsSchema>;

export function resolveEffectiveFrequency(
  settings: DeepReadonly<HeartflowSettings>,
  source: {
    platform: string;
    destination: { kind: string; groupId?: string; userId?: string };
  },
  asOf: string,
  focusActive: boolean,
): { frequency: number; ruleIndex: number | null } {
  const chatType = source.destination.kind === "group" ? "group" : "private";
  const targetId =
    chatType === "group"
      ? source.destination.groupId
      : source.destination.userId;
  let frequency =
    chatType === "group" ? settings.groupFrequency : settings.privateFrequency;
  let ruleIndex: number | null = null;
  let best: readonly [number, number] = [-1, -1];
  if (settings.dynamicFrequencyEnabled) {
    const date = new Date(asOf);
    const minute = date.getHours() * 60 + date.getMinutes();
    settings.dynamicFrequencyRules.forEach((rule, index) => {
      if (rule.chatType !== chatType) return;
      if (
        rule.platform &&
        rule.platform !== "*" &&
        rule.platform !== source.platform
      )
        return;
      if (rule.itemId && rule.itemId !== "*" && rule.itemId !== targetId)
        return;
      if (rule.itemId && !targetId) return;
      const targetPriority =
        (rule.itemId && rule.itemId !== "*" ? 2 : 0) +
        (rule.platform && rule.platform !== "*" ? 1 : 0);
      let timePriority = 0;
      if (rule.time && rule.time !== "*") {
        const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/u.exec(rule.time);
        if (!match) return;
        const start = Number(match[1]) * 60 + Number(match[2]);
        const end = Number(match[3]) * 60 + Number(match[4]);
        if (
          start > 1439 ||
          end > 1439 ||
          Number(match[2]) > 59 ||
          Number(match[4]) > 59
        )
          return;
        if (
          start <= end
            ? minute < start || minute > end
            : minute < start && minute > end
        )
          return;
        timePriority = 1;
      }
      if (
        targetPriority > best[0] ||
        (targetPriority === best[0] && timePriority > best[1])
      ) {
        best = [targetPriority, timePriority];
        frequency = rule.value;
        ruleIndex = index;
      }
    });
  }
  return {
    frequency: Math.min(
      1,
      Math.max(
        0,
        frequency * (focusActive ? settings.focusFrequencyMultiplier : 1),
      ),
    ),
    ruleIndex,
  };
}

const plannerInterruptSelector = defineInformationSelector({
  selectorId: "agent.heartflow.planner-interrupt",
  select: async ({ sourceAtom, ledger }) => {
    const selected = new Map<string, DeepReadonly<InformationAtom>>();
    const add = (atoms: readonly DeepReadonly<InformationAtom>[]) => {
      for (const atom of atoms) selected.set(atom.informationId, atom);
      return atoms;
    };
    add([sourceAtom]);
    const anchor =
      sourceAtom.kind === "core.model.task.requested"
        ? add(
            await ledger.find({
              informationIds: [
                String((sourceAtom.payload as any).sourceInformationId),
              ],
              limit: 1,
            }),
          )[0]
        : sourceAtom;
    const source = (anchor?.payload as any)?.source;
    if (!source) return [...selected.keys()];
    const scopeKey = scopeOf(source);
    const candidate = add(
      await ledger.find({
        kinds: [turnCandidateInformationKind.kind],
        ...(sourceAtom.kind === "core.model.task.requested" &&
        (anchor?.payload as any)?.candidateInformationId
          ? {
              informationIds: [
                String((anchor!.payload as any).candidateInformationId),
              ],
            }
          : {
              scopeKey,
              openOnly: true,
              registrationOrder: true,
              order: "desc" as const,
            }),
        limit: 1,
      }),
    )[0];
    if (!candidate) return [...selected.keys()];
    const claims = add(
      await ledger.related({
        from: [candidate.informationId],
        relation: "agent:turn-candidate",
        direction: "incoming",
        limit: 20,
      }),
    );
    const claim = claims.find(
      (atom) => atom.kind === turnClaimedInformationKind.kind,
    );
    if (!claim) return [...selected.keys()];
    add(
      await ledger.related({
        from: [candidate.informationId],
        relation: "core:context",
        direction: "outgoing",
        limit: 1,
      }),
    );
    const claimStatuses = add(
      await ledger.related({
        from: [claim.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 30,
      }),
    );
    const frozen = add(
      await ledger.related({
        from: [claim.informationId],
        relation: "agent:turn-claim",
        direction: "incoming",
        limit: 100,
      }),
    ).find((atom) => atom.kind === turnContextCompletedInformationKind.kind);
    for (const attention of claimStatuses.filter(
      (atom) => atom.kind === attentionArousalCompletedInformationKind.kind,
    )) {
      add(
        await ledger.related({
          from: [attention.informationId],
          relation: "core:caused-by",
          direction: "incoming",
          limit: 30,
        }),
      );
    }
    if (!frozen) return [...selected.keys()];
    const frozenIds = (frozen.payload.inputs as any[]).map((input) =>
      String(input.informationId),
    );
    const watermark = add(
      await ledger.find({
        kinds: [inboundTextInformationKind.kind],
        informationIds: frozenIds,
        registrationOrder: true,
        order: "desc",
        limit: 1,
      }),
    )[0];
    add(
      await ledger.find({
        kinds: [inboundTextInformationKind.kind],
        scopeKey,
        ...(watermark ? { afterInformationId: watermark.informationId } : {}),
        registrationOrder: true,
        order: "asc",
        limit: 1000,
        payloadContains: {
          source: {
            platform: source.platform,
            adapterId: source.adapterId,
            destination: source.destination,
          },
        },
      }),
    );
    return [...selected.keys()];
  },
});

export const heartflowStateSelector = defineInformationSelector({
  selectorId: "agent.heartflow.state",
  select: async ({ sourceAtom, ledger }) => {
    const selected = new Map<string, DeepReadonly<InformationAtom>>();
    const remember = (atoms: readonly DeepReadonly<InformationAtom>[]) => {
      for (const atom of atoms) selected.set(atom.informationId, atom);
      return atoms;
    };
    remember([sourceAtom]);

    let anchors: readonly DeepReadonly<InformationAtom>[] = [];
    if (sourceAtom.kind === turnCandidateInformationKind.kind) {
      anchors = [sourceAtom];
    } else if (sourceAtom.kind === observationWakeInformationKind.kind) {
      anchors = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "agent:turn-candidate",
          "outgoing",
          1,
        ),
      );
    } else if (sourceAtom.kind === personContextCompletedInformationKind.kind) {
      const inbound = remember(
        await ledger.related({
          from: [sourceAtom.informationId],
          relation: "core:status-of",
          direction: "outgoing",
          limit: 1,
        }),
      )[0];
      if (inbound !== undefined) {
        anchors = remember(
          await ledger.find({
            kinds: [turnCandidateInformationKind.kind],
            payloadContains: {
              sourceInformationIds: [inbound.informationId],
            },
            openOnly: true,
            order: "asc",
            limit: 1_000,
          }),
        );
        const recoveryClaims = remember(
          await related(
            ledger,
            inbound.informationId,
            "core:uses-context",
            "incoming",
            1000,
          ),
        ).filter(
          (a) =>
            a.kind === turnClaimedInformationKind.kind ||
            a.kind === observationWakeInformationKind.kind,
        );
        anchors = [
          ...anchors,
          ...(await candidatesForClaims(ledger, recoveryClaims, remember)),
        ];
      }
    } else if (sourceAtom.kind === turnClaimedInformationKind.kind) {
      anchors = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "agent:turn-candidate",
          "outgoing",
        ),
      );
    } else if (TURN_TERMINAL_KINDS.has(sourceAtom.kind)) {
      anchors = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "core:status-of",
          "outgoing",
        ),
      ).filter(({ kind }) => kind === turnCandidateInformationKind.kind);
    } else if (
      sourceAtom.kind === attentionArousalCompletedInformationKind.kind
    ) {
      remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "core:uses-context",
          "outgoing",
        ),
      );
      const claims = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "agent:turn-claim",
          "outgoing",
        ),
      );
      anchors = await candidatesForClaims(ledger, claims, remember);
    } else {
      // Runtime delivery terminals and execution.exhausted are injected kinds.
      const statusTargets = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "core:status-of",
          "outgoing",
        ),
      );
      const inboundCandidates = (
        await Promise.all(
          statusTargets
            .filter(({ kind }) => kind === inboundTextInformationKind.kind)
            .map((inbound) =>
              ledger.find({
                kinds: [turnCandidateInformationKind.kind],
                payloadContains: {
                  sourceInformationIds: [inbound.informationId],
                },
                order: "asc",
                limit: 1_000,
              }),
            ),
        )
      ).flat();
      remember(inboundCandidates);
      anchors = [
        ...(await traceTurnCandidates(ledger, statusTargets, remember)),
        ...inboundCandidates,
      ];
    }

    const scopes = new Set(
      anchors
        .filter(({ kind }) => kind === turnCandidateInformationKind.kind)
        .map((atom) => (atom.payload as any).scopeKey as string),
    );
    const candidates = [...anchors];
    for (const scopeKey of scopes) {
      let afterInformationId: string | undefined;
      for (;;) {
        const page = remember(
          await ledger.find({
            kinds: [turnCandidateInformationKind.kind],
            scopeKey,
            openOnly: true,
            registrationOrder: true,
            order: "asc",
            limit: 1000,
            ...(afterInformationId ? { afterInformationId } : {}),
          }),
        );
        candidates.push(...page);
        if (page.length < 1000) break;
        afterInformationId = page.at(-1)!.informationId;
      }
    }
    for (const candidate of uniqueAtoms(candidates)) {
      if (candidate.kind !== turnCandidateInformationKind.kind) continue;
      await hydrateCandidate(ledger, candidate, remember);
    }
    return [...selected.keys()];
  },
});

export const heartflowMemorySelector = defineInformationSelector({
  selectorId: "agent.heartflow.optional-memory",
  select: async ({ sourceAtom, ledger }) => {
    let candidates: readonly DeepReadonly<InformationAtom>[] = [];
    if (sourceAtom.kind === turnCandidateInformationKind.kind) {
      candidates = [sourceAtom];
    } else if (sourceAtom.kind === personContextCompletedInformationKind.kind) {
      const inbound = (
        await ledger.related({
          from: [sourceAtom.informationId],
          relation: "core:status-of",
          direction: "outgoing",
          limit: 1,
        })
      )[0];
      if (inbound !== undefined) {
        candidates = await ledger.find({
          kinds: [turnCandidateInformationKind.kind],
          payloadContains: { sourceInformationIds: [inbound.informationId] },
          order: "asc",
          limit: 1_000,
        });
      }
    }
    const memories = new Map<string, DeepReadonly<InformationAtom>>();
    for (const candidate of candidates) {
      const inbounds = (
        await ledger.related({
          from: [candidate.informationId],
          relation: "core:uses-context",
          direction: "outgoing",
          limit: 1_000,
        })
      ).filter(({ kind }) => kind === inboundTextInformationKind.kind);
      const query = inbounds
        .map((atom) => (atom.payload as any).text as string)
        .join("\n")
        .trim();
      if (query.length === 0) continue;
      try {
        const selected = await ledger.retrieve({
          strategyId: MEMORY_RETRIEVAL_STRATEGY_ID,
          input: {
            query,
            scopes: inbounds.map((atom) => {
              const source = inboundTextInformationKind.payloadSchema.parse(
                atom.payload,
              ).source;
              return {
                platform: source.platform,
                adapterId: source.adapterId,
                destination: source.destination,
              };
            }),
            occurredBefore: (candidate.payload as any).asOf,
            excludeSourceInformationIds: inbounds.map(
              ({ informationId }) => informationId,
            ),
          },
          limit: 8,
        });
        for (const atom of selected) memories.set(atom.informationId, atom);
      } catch {
        // Optional Memory never blocks the online turn.
      }
    }
    return [...memories.keys()];
  },
});

export function createHeartflowModule(options: CreateHeartflowModuleOptions) {
  const cognitive = options.cognitionIdentity
    ? createCognitionMemorySelector(options.cognitionIdentity)
    : undefined;
  const memorySelector = cognitive
    ? defineInformationSelector({
        selectorId: heartflowMemorySelector.selectorId,
        select: async (context) => [
          ...new Set([
            ...(await heartflowMemorySelector.select(context)),
            ...(await cognitive.select(context)),
          ]),
        ],
      })
    : heartflowMemorySelector;
  const deliveryKinds = [
    options.deliveryDeliveredInformationKind,
    options.deliveryFailedInformationKind,
  ] as const;
  const modelTaskFailureKinds = [
    options.modelTaskFailedInformationKind,
    options.modelTaskCancelledInformationKind,
  ] as const;
  const maybeInterruptPlanner = async (
    context: InformationModuleHandlerContext,
    settings: DeepReadonly<HeartflowSettings>,
  ): Promise<boolean> => {
    const atoms = await context.select(plannerInterruptSelector);
    const source =
      context.sourceAtom ??
      atoms.find(
        (atom) =>
          atom.kind === inboundTextInformationKind.kind ||
          atom.kind === attentionArousalCompletedInformationKind.kind,
      );
    const candidate = atoms.find(
      (atom) => atom.kind === turnCandidateInformationKind.kind,
    );
    if (!candidate) return false;
    const claim = atoms.find(
      (atom) =>
        atom.kind === turnClaimedInformationKind.kind &&
        (atom.payload as any).candidateInformationId ===
          candidate.informationId,
    );
    if (!claim) return false;
    const interrupted = atoms.find(
      (atom) =>
        atom.kind === turnDecisionInterruptedInformationKind.kind &&
        (atom.payload as any).claimInformationId === claim.informationId,
    );
    const requests = atoms.filter(
      (atom) =>
        atom.kind === "core.model.task.requested" &&
        (atom.payload as any).taskId === PLANNER_TASK_ID,
    );
    if (interrupted) {
      for (const requested of requests) {
        await context.use(options.modelTaskCapability).cancel({
          requestedInformationId: requested.informationId,
          reason: "New message interrupted Planner",
        });
      }
      return true;
    }
    if (source?.kind === "core.model.task.requested") return false;
    const frozen = atoms.find(
      (atom) =>
        atom.kind === turnContextCompletedInformationKind.kind &&
        (atom.payload as any).claimInformationId === claim.informationId,
    );
    const attention = atoms.find(
      (atom) =>
        atom.kind === attentionArousalCompletedInformationKind.kind &&
        (atom.payload as any).claimInformationId === claim.informationId &&
        (atom.payload as any).outcome === "attend",
    );
    if (!frozen || !attention) return false;
    const attempt = Number((candidate.payload as any).rebuildAttempt ?? 0);
    if (attempt >= settings.plannerInterruptMaxConsecutiveCount) return false;
    const consumed = new Set(
      (frozen.payload.inputs as any[]).map((input) => input.informationId),
    );
    const incoming = atoms.filter(
      (atom) =>
        atom.kind === inboundTextInformationKind.kind &&
        !consumed.has(atom.informationId),
    );
    const trigger = incoming.at(-1);
    if (!trigger) return false;
    const runtime = atoms.find((atom) => atom.kind === "core.runtime.context");
    if (!runtime) return false;
    const winner = await context.commitTerminal(
      "agent.turn.decision",
      claim.informationId,
      turnDecisionInterruptedInformationKind,
      {
        payload: {
          candidateInformationId: candidate.informationId,
          claimInformationId: claim.informationId,
          triggerInformationId: trigger.informationId,
          rebuildAttempt: attempt + 1,
        },
        references: [
          {
            relation: "core:uses-context",
            informationId: trigger.informationId,
          },
          { relation: "core:status-of", informationId: claim.informationId },
        ],
        contextInformationId: runtime.informationId,
      },
    );
    if (winner.kind !== turnDecisionInterruptedInformationKind.kind)
      return false;
    await context.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnInterruptedInformationKind,
      {
        payload: {
          candidateInformationId: candidate.informationId,
          claimInformationId: claim.informationId,
          scopeKey: String((candidate.payload as any).scopeKey),
          triggerInformationId: trigger.informationId,
          rebuildAttempt: attempt + 1,
        },
        references: terminalReferences(
          candidate.informationId,
          claim.informationId,
        ),
        contextInformationId: runtime.informationId,
      },
    );
    for (const requested of requests) {
      await context.use(options.modelTaskCapability).cancel({
        requestedInformationId: requested.informationId,
        reason: "New message interrupted Planner",
      });
    }
    return true;
  };
  const module = defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      definitionId: "agent.heartflow.online",
      displayName: "在线回合编排",
      summary: "协调候选认领、上下文冻结、规划和回合终态。",
      description:
        "消费回合候选及身份、注意力、模型和投递结果，经身份屏障冻结上下文，再请求 Planner 选择发言、等待或静默；输出消息意图、等待请求和回合终态，不执行平台传输。",
      settingsSchema: heartflowSettingsSchema,
      promptTemplates: [plannerTemplateDeclaration],
      consumes: [
        inboundTextInformationKind,
        observationWakeInformationKind,
        turnCandidateInformationKind,
        personContextCompletedInformationKind,
        turnClaimedInformationKind,
        attentionArousalCompletedInformationKind,
        turnCompletedInformationKind,
        turnWaitingInformationKind,
        turnSilentInformationKind,
        turnFailedInformationKind,
        turnSupersededInformationKind,
        turnInterruptedInformationKind,
        ...(options.modelTaskRequestedInformationKind
          ? [options.modelTaskRequestedInformationKind]
          : []),
        ...deliveryKinds,
        ...modelTaskFailureKinds,
        options.executionExhaustedInformationKind,
      ],
      produces: [
        focusOpened,
        plannerDecisionInformationKind,
        turnClaimedInformationKind,
        turnStartedInformationKind,
        turnDecisionSupersededInformationKind,
        turnDecisionInterruptedInformationKind,
        turnContextCompletedInformationKind,
        messageIntentRequestedInformationKind,
        waitRequestedInformationKind,
        turnCompletedInformationKind,
        turnWaitingInformationKind,
        turnSilentInformationKind,
        turnFailedInformationKind,
        turnSupersededInformationKind,
        turnInterruptedInformationKind,
      ],
      selectors: [
        heartflowStateSelector,
        plannerInterruptSelector,
        memorySelector,
        plannerContextSelector,
      ],
      promptRenderers: [],
      requires: [
        options.modelTaskCapability,
        ...(options.messageAuthorizationCapability
          ? [options.messageAuthorizationCapability]
          : []),
      ],
      provides: [],
    },
    create: ({ settings, activation }) => ({
      provisions: [],
      describeStartup: () => ({
        summary: "Information DAG heartflow ready",
        fields: { identityBarrier: "required", plannerRounds: 1 },
      }),
      subscriptions: [
        onInformation(
          inboundTextInformationKind,
          {
            subscriptionId: "agent.heartflow.interrupt.inbound",
            delivery: "durable",
          },
          async (_atom, context) => {
            await maybeInterruptPlanner(context, settings);
          },
        ),
        ...(options.modelTaskRequestedInformationKind
          ? [
              onInformation(
                options.modelTaskRequestedInformationKind,
                {
                  subscriptionId: "agent.heartflow.interrupt.requested",
                  delivery: "durable",
                },
                async (_atom, context) => {
                  await maybeInterruptPlanner(context, settings);
                },
              ),
            ]
          : []),
        ...[
          observationWakeInformationKind,
          turnCandidateInformationKind,
          personContextCompletedInformationKind,
          turnClaimedInformationKind,
          turnCompletedInformationKind,
          turnWaitingInformationKind,
          turnSilentInformationKind,
          turnFailedInformationKind,
          turnSupersededInformationKind,
          turnInterruptedInformationKind,
        ].map((definition) =>
          onInformation(
            definition as AnyKind,
            {
              subscriptionId: `agent.heartflow.progress.${definition.kind}`,
              delivery: "durable",
            },
            async (_atom, context) => {
              const state = await context.select(heartflowStateSelector);
              const memories = await context.select(memorySelector);
              await progressCandidates(state, memories, settings, context);
            },
          ),
        ),
        onInformation(
          attentionArousalCompletedInformationKind,
          {
            subscriptionId: "agent.heartflow.dispatch.decision",
            delivery: "durable",
          },
          async (decision, context) => {
            if (await maybeInterruptPlanner(context, settings)) return;
            const gate = decision.payload as AttentionArousalPayload;
            const state = await context.select(heartflowStateSelector);
            if (turnTerminalFor(gate.candidateInformationId, state)) return;
            if (
              state.some(
                (atom) =>
                  atom.kind === turnDecisionSupersededInformationKind.kind &&
                  atom.payload.claimInformationId === gate.claimInformationId,
              )
            )
              return;
            if (gate.outcome !== "attend") {
              await dispatchDecision(decision, state, context);
              return;
            }
            let selected = [...(await context.select(plannerContextSelector))];
            const turn = selected.find(
              (atom) => atom.informationId === gate.turnContextInformationId,
            )!;
            const authorization = options.messageAuthorizationCapability
              ? context.use(options.messageAuthorizationCapability)
              : undefined;
            if (authorization?.conversation) {
              const conversation = await authorization.conversation(turn);
              selected = [
                ...selected.filter(
                  (a) => a.kind !== conversationContextInformationKind.kind,
                ),
                conversation,
              ];
            }
            const runtimeContextId = decision.references.find(
              (reference) => reference.relation === "core:context",
            )!.informationId;
            const persisted = selected.find(
              (atom) =>
                atom.kind === "core.model.task.requested" &&
                atom.payload.taskId === PLANNER_TASK_ID &&
                atom.payload.version === "1" &&
                (
                  atom.payload.activation as {
                    instanceId?: string;
                    definitionId?: string;
                  }
                )?.instanceId === activation.instanceId &&
                (atom.payload.activation as { definitionId?: string })
                  ?.definitionId === activation.definitionId,
            );
            const byId = new Map(
              selected.map((atom) => [atom.informationId, atom]),
            );
            const taskAtoms = persisted
              ? (persisted.payload.contextInformationIds as string[]).map(
                  (id) => {
                    const atom = byId.get(id);
                    if (!atom)
                      throw new Error("Missing persisted Planner context");
                    return atom;
                  },
                )
              : selected.filter(
                  (atom) => atom.kind !== "core.model.task.requested",
                );
            const result = await context
              .use(options.modelTaskCapability)
              .execute({
                task: {
                  taskId: PLANNER_TASK_ID,
                  version: "1",
                  outputMode: "object",
                  outputSchema: plannerActionSchema,
                  allowedTiers: ["light", "heavy"],
                },
                sourceInformationId: decision.informationId,
                contextInformationId: runtimeContextId,
                activation,
                selectionPolicy: { tier: "light" },
                prompt: persisted
                  ? (persisted.payload.prompt as unknown as CompiledPrompt)
                  : compilePlannerPrompt(
                      options.agentIdentity,
                      taskAtoms,
                      turn,
                      options.plannerTemplate,
                    ),
                contextAtoms: taskAtoms,
              });
            const parsed =
              result.status === "completed"
                ? plannerActionSchema.safeParse(result.output)
                : undefined;
            let action: z.infer<
              typeof plannerDecisionInformationKind.payloadSchema
            >["action"] = parsed?.success
              ? parsed.data
              : { action: "silent", reason: "planner-unavailable" };
            if (
              action.action === "wait" &&
              gate.attempt >= gate.totalWaitBudget
            )
              action = { action: "silent", reason: "wait-budget-exhausted" };
            const winner = await context.commitTerminal(
              "agent.turn.decision",
              gate.claimInformationId,
              plannerDecisionInformationKind,
              {
                payload: { gateInformationId: decision.informationId, action },
                references: [
                  {
                    relation: "core:uses-context",
                    informationId: result.terminalInformationId,
                  },
                  {
                    relation: "core:status-of",
                    informationId: gate.claimInformationId,
                  },
                ],
              },
            );
            if (
              winner.kind !== plannerDecisionInformationKind.kind ||
              winner.payload.gateInformationId !== decision.informationId
            )
              return;
            action = plannerDecisionInformationKind.payloadSchema.parse(
              winner.payload,
            ).action;
            if (
              action.action === "message" &&
              action.target &&
              action.target.kind !== "current"
            ) {
              const routed = authorization?.route
                ? await authorization.route(turn, winner)
                : { status: "failed", reason: "target-unavailable" };
              if (routed.status === "failed") {
                await context.commitTerminal(
                  "agent.turn.terminal",
                  gate.candidateInformationId,
                  turnFailedInformationKind,
                  {
                    payload: {
                      candidateInformationId: gate.candidateInformationId,
                      claimInformationId: gate.claimInformationId,
                      scopeKey: String(turn.payload.scopeKey),
                      reason: routed.reason ?? "target-unavailable",
                    },
                    references: terminalReferences(
                      gate.candidateInformationId,
                      gate.claimInformationId,
                    ),
                  },
                );
              }
              return;
            }
            const payload = {
              ...decision.payload,
              outcome:
                action.action === "message"
                  ? "attend"
                  : action.action === "wait"
                    ? "defer"
                    : "ignore",
              reasonCodes: [action.reason],
              totalWaitBudget: gate.totalWaitBudget,
              ...(action.action === "wait"
                ? {
                    delayMs: action.waitSeconds * 1000,
                    dueAt: new Date(
                      Date.parse(winner.occurredAt) + action.waitSeconds * 1000,
                    ).toISOString(),
                  }
                : {}),
            };
            const current = await context.select(heartflowStateSelector);
            await dispatchDecision({ ...decision, payload }, current, context);
          },
        ),
        ...deliveryKinds.map((definition) =>
          onInformation(
            definition,
            {
              subscriptionId: `agent.heartflow.delivery.${definition.kind}`,
              delivery: "durable",
            },
            async (terminal, context) => {
              const state = await context.select(heartflowStateSelector);
              await finishDelivery(
                terminal,
                definition === options.deliveryDeliveredInformationKind,
                state,
                context,
              );
              const memories = await context.select(memorySelector);
              await progressCandidates(state, memories, settings, context);
            },
          ),
        ),
        ...modelTaskFailureKinds.map((definition) =>
          onInformation(
            definition,
            {
              subscriptionId: `agent.heartflow.model-task.${definition.kind}`,
              delivery: "durable",
            },
            async (terminal, context) => {
              const state = await context.select(heartflowStateSelector);
              if (terminal.payload.taskId === PLANNER_TASK_ID) return;
              await failOpenTurns(
                terminal,
                definition === options.modelTaskFailedInformationKind
                  ? "model-task-failed"
                  : "model-task-cancelled",
                state,
                context,
              );
            },
          ),
        ),
        onInformation(
          options.executionExhaustedInformationKind,
          {
            subscriptionId: "agent.heartflow.execution-exhausted",
            delivery: "durable",
          },
          async (exhausted, context) => {
            const state = await context.select(heartflowStateSelector);
            await failOpenTurns(
              exhausted,
              "execution-exhausted",
              state,
              context,
            );
          },
        ),
      ],
    }),
  });
  return module;
}

async function progressCandidates(
  atoms: readonly DeepReadonly<InformationAtom>[],
  memories: readonly DeepReadonly<InformationAtom>[],
  settings: DeepReadonly<HeartflowSettings>,
  context: InformationModuleHandlerContext,
) {
  const candidates = atoms.filter(
    (a) =>
      a.kind === turnCandidateInformationKind.kind &&
      !turnTerminalFor(a.informationId, atoms) &&
      a.payload.managementAuthorizationId === undefined,
  );
  const scopes = new Set(candidates.map((a) => String(a.payload.scopeKey)));
  for (const scope of scopes) {
    const open = candidates
      .filter((a) => a.payload.scopeKey === scope)
      .sort(compareCandidates);
    const winner = open.at(-1)!;
    // 仅恢复路径合并旧积压。新输入正常由 Heartbeat 的开放槽保留到下一观察。
    const sourceInformationIds = [
      ...new Set(
        open.flatMap(
          (a) => (a.payload as any).sourceInformationIds as string[],
        ),
      ),
    ];
    const merged = {
      ...winner,
      payload: { ...winner.payload, sourceInformationIds },
    };
    await progressCandidate(merged, atoms, memories, settings, context);
    if (open.length < 2) continue;
    const refreshed = await context.select(heartflowStateSelector);
    const claim = claimForCandidate(winner.informationId, refreshed);
    const runtime = referenced(
      winner,
      "core:context",
      new Map(atoms.map((a) => [a.informationId, a])),
    )[0];
    if (!claim || !runtime) continue;
    for (const candidate of open.slice(0, -1)) {
      if (turnTerminalFor(candidate.informationId, refreshed)) continue;
      await supersedeCandidate(
        candidate,
        claim,
        winner.informationId,
        runtime.informationId,
        context,
      );
    }
  }
}

async function progressCandidate(
  candidate: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
  memories: readonly DeepReadonly<InformationAtom>[],
  settings: DeepReadonly<HeartflowSettings>,
  context: InformationModuleHandlerContext,
) {
  const map = new Map(atoms.map((atom) => [atom.informationId, atom]));
  if (turnTerminalFor(candidate.informationId, atoms) !== undefined) return;
  const payload = { ...candidate.payload } as any;
  if (payload.managementAuthorizationId !== undefined) return;
  const runtimeContext = referenced(candidate, "core:context", map)[0];
  if (runtimeContext === undefined) return;
  let effectiveSourceInformationIds = [
    ...(payload.sourceInformationIds as string[]),
  ];

  const claims = atoms
    .filter(
      (atom) =>
        atom.kind === turnClaimedInformationKind.kind &&
        (atom.payload as any).scopeKey === payload.scopeKey,
    )
    .sort(compareClaims);
  const latestClaim = claims.at(-1);
  const latestCandidate =
    latestClaim === undefined
      ? undefined
      : referenced(latestClaim, "agent:turn-candidate", map)[0];
  let predecessor =
    latestCandidate === undefined
      ? undefined
      : turnTerminalFor(latestCandidate.informationId, atoms);

  if (
    latestClaim !== undefined &&
    latestCandidate !== undefined &&
    latestCandidate.informationId !== candidate.informationId
  ) {
    if (compareCandidates(candidate, latestCandidate) <= 0) {
      await supersedeCandidate(
        candidate,
        latestClaim,
        latestCandidate.informationId,
        runtimeContext.informationId,
        context,
      );
      return;
    }
    if (predecessor === undefined) {
      const decisionGate = await context.commitTerminal(
        "agent.turn.decision",
        latestClaim.informationId,
        turnDecisionSupersededInformationKind,
        {
          payload: {
            candidateInformationId: latestCandidate.informationId,
            claimInformationId: latestClaim.informationId,
            replacementCandidateInformationId: candidate.informationId,
          },
          references: [
            {
              relation: "core:status-of",
              informationId: latestClaim.informationId,
            },
          ],
          contextInformationId: runtimeContext.informationId,
        },
      );
      if (decisionGate.kind !== turnDecisionSupersededInformationKind.kind)
        return;
      const oldContext = referenced(latestCandidate, "core:context", map)[0];
      predecessor = await context.commitTerminal(
        "agent.turn.terminal",
        latestCandidate.informationId,
        turnSupersededInformationKind,
        {
          payload: {
            candidateInformationId: latestCandidate.informationId,
            claimInformationId: latestClaim.informationId,
            scopeKey: payload.scopeKey,
            replacementCandidateInformationId: candidate.informationId,
          },
          references: terminalReferences(
            latestCandidate.informationId,
            latestClaim.informationId,
          ),
          ...(oldContext === undefined
            ? {}
            : { contextInformationId: oldContext.informationId }),
        },
      );
      effectiveSourceInformationIds = [
        ...new Set([
          ...((latestCandidate.payload as any)
            .sourceInformationIds as string[]),
          ...effectiveSourceInformationIds,
        ]),
      ];
    }
  }

  const ownClaim = claimForCandidate(candidate.informationId, atoms);
  const predecessorId = ownClaim
    ? ((ownClaim.payload as any).predecessorTerminalInformationId ?? undefined)
    : predecessor?.informationId;
  const generation =
    latestClaim === undefined
      ? 0
      : ((latestClaim.payload as any).generation ?? 0) + 1;
  const claim = await context.registerOnce(
    "agent.turn.claim",
    `${payload.scopeKey}:${predecessorId ?? "root"}`,
    turnClaimedInformationKind,
    {
      payload: {
        candidateInformationId: candidate.informationId,
        scopeKey: payload.scopeKey,
        generation,
        predecessorTerminalInformationId: predecessorId ?? null,
      },
      references: [
        ...effectiveSourceInformationIds.map((informationId) => ({
          relation: "core:uses-context",
          informationId,
        })),
        {
          relation: "agent:turn-candidate",
          informationId: candidate.informationId,
        },
      ],
      contextInformationId: runtimeContext.informationId,
    },
  );
  if ((claim.payload as any).candidateInformationId !== candidate.informationId)
    return;

  const frozenSources = claim.references
    .filter((r) => r.relation === "core:uses-context")
    .map((r) => r.informationId);
  if (frozenSources.length) effectiveSourceInformationIds = frozenSources;
  const frozenContext = atoms.find(
    (a) =>
      a.kind === turnContextCompletedInformationKind.kind &&
      a.payload.claimInformationId === claim.informationId,
  );
  if (frozenContext) {
    effectiveSourceInformationIds = (frozenContext.payload.inputs as any[]).map(
      (i) => i.informationId,
    );
    payload.asOf = frozenContext.payload.asOf;
  } else {
    const wakeSources = atoms
      .filter(
        (a) =>
          a.kind === observationWakeInformationKind.kind &&
          a.references.some(
            (r) =>
              r.relation === "agent:turn-candidate" &&
              r.informationId === candidate.informationId,
          ),
      )
      .flatMap((a) =>
        a.references
          .filter((r) => r.relation === "core:uses-context")
          .map((r) => r.informationId),
      );
    effectiveSourceInformationIds = [
      ...new Set([...effectiveSourceInformationIds, ...wakeSources]),
    ];
    for (const id of wakeSources) {
      const occurredAt = map.get(id)?.occurredAt;
      if (occurredAt && occurredAt > payload.asOf) payload.asOf = occurredAt;
    }
  }

  await context.registerOnce(
    "agent.turn.started",
    claim.informationId,
    turnStartedInformationKind,
    {
      payload: {
        candidateInformationId: candidate.informationId,
        claimInformationId: claim.informationId,
        scopeKey: payload.scopeKey,
        generation: (claim.payload as any).generation,
      },
      references: [
        { relation: "agent:turn-claim", informationId: claim.informationId },
      ],
      contextInformationId: runtimeContext.informationId,
    },
  );

  const inputs = effectiveSourceInformationIds.map((id) => {
    const inbound = map.get(id);
    const identity = identityTerminalFor(id, atoms);
    return inbound === undefined || identity === undefined
      ? undefined
      : { inbound, identity };
  });
  if (inputs.some((input) => input === undefined)) {
    if (
      effectiveSourceInformationIds.some((informationId) =>
        hasExhaustedStatus(informationId, atoms),
      )
    )
      await context.commitTerminal(
        "agent.turn.terminal",
        candidate.informationId,
        turnFailedInformationKind,
        {
          payload: {
            candidateInformationId: candidate.informationId,
            claimInformationId: claim.informationId,
            scopeKey: payload.scopeKey,
            reason: "identity-exhausted",
          },
          references: terminalReferences(
            candidate.informationId,
            claim.informationId,
          ),
          contextInformationId: runtimeContext.informationId,
        },
      );
    return;
  }
  const completeInputs = inputs as {
    inbound: DeepReadonly<InformationAtom>;
    identity: DeepReadonly<InformationAtom>;
  }[];
  const last = completeInputs.at(-1)!;
  const source = (last.inbound.payload as any).source;
  const text = completeInputs
    .map(({ inbound }) => (inbound.payload as any).text as string)
    .join("\n");
  const selfId = source.selfId as string | undefined;
  const mentionedSelf =
    selfId !== undefined &&
    (source.mentions ?? []).some(
      (mention: any) => mention.kind === "user" && mention.id === selfId,
    );
  const deliveredMessageIds = new Set(
    atoms
      .filter(({ kind }) => kind === "core.delivery.delivered")
      .flatMap((atom) => {
        const id = (atom.payload as any).platformMessageId;
        return typeof id === "string" ? [id] : [];
      }),
  );
  const repliedToSelf =
    source.replyTo !== undefined &&
    ((selfId !== undefined && source.replyTo.senderId === selfId) ||
      deliveredMessageIds.has(source.replyTo.platformMessageId));
  const normalizedText = text.toLocaleLowerCase();
  const namedSelf = settings.botNames.some((name) =>
    normalizedText.includes(name.toLocaleLowerCase()),
  );
  const asOfMs = Date.parse(payload.asOf);
  const recentStartMs = asOfMs - 5 * 60_000;
  const recentInbound = atoms.filter(
    (atom) =>
      atom.kind === inboundTextInformationKind.kind &&
      Date.parse(atom.occurredAt) >= recentStartMs &&
      Date.parse(atom.occurredAt) <= asOfMs &&
      sameScope((atom.payload as any).source, source),
  );
  const recentDelivered = atoms.filter(
    (atom) =>
      atom.kind === "core.delivery.delivered" &&
      Date.parse(atom.occurredAt) >= recentStartMs &&
      Date.parse(atom.occurredAt) <= asOfMs &&
      sameDeliveryScope(atom.payload as any, source),
  );
  const intervalInbounds = atoms
    .filter(
      (atom) =>
        atom.kind === inboundTextInformationKind.kind &&
        Date.parse(atom.occurredAt) >= asOfMs - 30 * 60_000 &&
        Date.parse(atom.occurredAt) <= asOfMs &&
        sameScope((atom.payload as any).source, source),
    )
    .sort(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
    );
  const intervals = intervalInbounds.slice(1).flatMap((atom, index) => {
    const interval =
      Date.parse(atom.occurredAt) -
      Date.parse(intervalInbounds[index]!.occurredAt);
    return interval >= 2_000 ? [interval] : [];
  });
  const averageIntervalMs =
    intervals.length === 0
      ? 30_000
      : Math.max(
          30_000,
          intervals.reduce((sum, value) => sum + value, 0) / intervals.length,
        );
  const lastInboundAt = intervalInbounds.at(-1)?.occurredAt;
  const idleReachedAverage =
    lastInboundAt !== undefined &&
    asOfMs - Date.parse(lastInboundAt) >= averageIntervalMs;
  const isGroup = source.destination?.kind === "group";
  // Web and other point-to-agent transports are direct conversations just
  // like platform private messages; only an explicit group uses group policy.
  const isPrivate = !isGroup;
  const safe = completeInputs.every(
    ({ identity }) => (identity.payload as any).status !== "failed",
  );
  let focus = isGroup
    ? activeFocus(atoms, payload.scopeKey, payload.asOf)
    : undefined;
  const directInput = completeInputs.findLast(({ inbound }) => {
    const p = inboundTextInformationKind.payloadSchema.parse(inbound.payload);
    return (
      settings.botNames.some((name) =>
        p.text.toLocaleLowerCase().includes(name.toLocaleLowerCase()),
      ) ||
      (p.source.selfId !== undefined &&
        (p.source.mentions?.some(
          (m: { kind: string; id?: string }) =>
            m.kind === "user" && m.id === p.source.selfId,
        ) ||
          p.source.replyTo?.senderId === p.source.selfId)) ||
      (p.source.replyTo !== undefined &&
        deliveredMessageIds.has(p.source.replyTo.platformMessageId))
    );
  });
  if (isGroup && directInput) {
    const direct = directInput.inbound;
    const opened = await context.registerOnce(
      "agent.attention.focus.open",
      direct.informationId,
      focusOpened,
      {
        payload: {
          scopeKey: payload.scopeKey,
          generation: direct.informationId,
          startedAt: direct.occurredAt,
          expiresAt: new Date(
            Date.parse(direct.occurredAt) + settings.focusIdleMs,
          ).toISOString(),
          reason: mentionedSelf
            ? "mentioned-self"
            : repliedToSelf
              ? "replied-to-self"
              : "named-self",
          sourceInformationId: direct.informationId,
        },
        references: [
          {
            relation: "core:uses-context",
            informationId: direct.informationId,
          },
        ],
        contextInformationId: runtimeContext.informationId,
      },
    );
    focus = activeFocus(
      [
        ...atoms.filter((a) => a.informationId !== opened.informationId),
        opened,
      ],
      payload.scopeKey,
      payload.asOf,
    );
  }
  const effectiveFrequency = resolveEffectiveFrequency(
    settings,
    source,
    payload.asOf,
    focus !== undefined,
  );
  const backlog = assessInputBacklog(
    completeInputs.map(({ inbound }) => inbound.occurredAt),
    context.now().toISOString(),
    settings.staleAfterMs,
  );
  await context.registerOnce(
    "agent.turn.context.completed",
    claim.informationId,
    turnContextCompletedInformationKind,
    {
      payload: {
        candidateInformationId: candidate.informationId,
        claimInformationId: claim.informationId,
        scopeKey: payload.scopeKey,
        asOf: payload.asOf,
        backlog: {
          isBacklog: backlog.isBacklog,
          evaluatedAt: backlog.evaluatedAt,
          oldestInputAgeMs: backlog.oldestInputAgeMs,
          newestInputAgeMs: backlog.newestInputAgeMs,
          thresholdMs: backlog.thresholdMs,
        },
        inputs: completeInputs.map(({ inbound, identity }) => ({
          informationId: inbound.informationId,
          occurredAt: inbound.occurredAt,
          text: (inbound.payload as any).text,
          source: (inbound.payload as any).source,
          identity: {
            terminalInformationId: identity.informationId,
            status: (identity.payload as any).status,
            scopeMode: (identity.payload as any).scopeMode,
            ...copyOptionalIdentity(identity.payload as any),
          },
        })),
        text,
        source,
        messageCount: completeInputs.length,
        isPrivate,
        isGroup,
        focusActive: focus !== undefined,
        ...(focus
          ? {
              focusInformationId: focus.informationId,
              focusExpiresAt: String(focus.payload.expiresAt),
            }
          : {}),
        mentionedSelf,
        repliedToSelf,
        namedSelf,
        recentSelfReplies: recentDelivered.length,
        recentWindowMessages: recentInbound.length + recentDelivered.length,
        idleReachedAverage,
        frequency: effectiveFrequency.frequency,
        frequencyRuleIndex: effectiveFrequency.ruleIndex,
        muted: settings.muted,
        safe,
        destinationAvailable: source.destination !== undefined,
        stale:
          Number.isFinite(asOfMs) &&
          Date.parse(payload.firedAt) - asOfMs > settings.staleAfterMs,
        ...(memories.length === 0
          ? {}
          : { memory: memories.map(({ informationId }) => informationId) }),
        attempt: payload.attempt,
        totalWaitBudget: payload.totalWaitBudget,
      },
      references: [
        { relation: "agent:turn-claim", informationId: claim.informationId },
        ...completeInputs.flatMap(({ inbound, identity }) => [
          {
            relation: "core:uses-context",
            informationId: inbound.informationId,
          },
          {
            relation: "core:uses-context",
            informationId: identity.informationId,
          },
        ]),
        ...(focus
          ? [
              {
                relation: "core:uses-context",
                informationId: focus.informationId,
              },
            ]
          : []),
        ...memories.map(({ informationId }) => ({
          relation: "core:uses-context" as const,
          informationId,
        })),
      ],
      contextInformationId: runtimeContext.informationId,
    },
  );
}

async function dispatchDecision(
  decision: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const payload = decision.payload as AttentionArousalPayload;
  const candidate = atoms.find(
    (atom) => atom.informationId === payload.candidateInformationId,
  );
  const claim = atoms.find(
    (atom) => atom.informationId === payload.claimInformationId,
  );
  const turnContext = atoms.find(
    (atom) => atom.informationId === payload.turnContextInformationId,
  );
  if (
    candidate === undefined ||
    claim === undefined ||
    turnContext === undefined
  )
    throw new Error("Speech decision references an incomplete turn");
  assertTurnLink(candidate, claim, turnContext);
  if (turnTerminalFor(candidate.informationId, atoms) !== undefined) return;
  const candidatePayload = candidate.payload as any;
  const terminalInput = {
    candidateInformationId: candidate.informationId,
    claimInformationId: claim.informationId,
    scopeKey: candidatePayload.scopeKey,
  };
  if (payload.outcome === "attend") {
    const targetInput = (turnContext.payload as any).inputs.at(-1);
    if (targetInput === undefined)
      throw new Error("Attend decision requires a target turn input");
    await context.registerOnce(
      "agent.heartflow.message-intent",
      claim.informationId,
      messageIntentRequestedInformationKind,
      {
        payload: {
          target: {
            adapterId: targetInput.source.adapterId,
            platform: targetInput.source.platform,
            destination: targetInput.source.destination,
          },
          turn: {
            candidateInformationId: candidate.informationId,
            claimInformationId: claim.informationId,
            contextInformationId: turnContext.informationId,
          },
          memoryInformationIds: Array.isArray(
            (turnContext.payload as any).memory,
          )
            ? (turnContext.payload as any).memory
            : [],
        },
        references: [
          {
            relation: "core:uses-context",
            informationId: turnContext.informationId,
          },
          { relation: "agent:turn-claim", informationId: claim.informationId },
          {
            relation: "agent:turn-candidate",
            informationId: candidate.informationId,
          },
        ],
      },
    );
    return;
  }
  if (payload.outcome === "defer") {
    if (payload.dueAt === undefined || payload.delayMs === undefined)
      throw new Error("Wait decision requires dueAt and delayMs");
    const sourceInformationIds = (turnContext.payload as any).inputs.map(
      (input: any) => input.informationId,
    );
    await context.registerOnce(
      "agent.heartflow.wait",
      claim.informationId,
      waitRequestedInformationKind,
      {
        payload: {
          dueAt: payload.dueAt,
          delayMs: payload.delayMs,
          reason: payload.reasonCodes[0] ?? "score-below-speak-threshold",
          attempt: payload.attempt + 1,
          totalWaitBudget: payload.totalWaitBudget,
          wakePolicy: payload.wakePolicy ?? "recheckAt",
          wakeOnMessage: true,
          source: payload.source,
          sourceInformationIds,
        },
        references: sourceInformationIds.map((informationId: string) => ({
          relation: "core:uses-context",
          informationId,
        })),
      },
    );
    await context.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnWaitingInformationKind,
      {
        payload: { ...terminalInput, dueAt: payload.dueAt },
        references: terminalReferences(
          candidate.informationId,
          claim.informationId,
        ),
      },
    );
    return;
  }
  await context.commitTerminal(
    "agent.turn.terminal",
    candidate.informationId,
    turnSilentInformationKind,
    {
      payload: { ...terminalInput, reasonCodes: payload.reasonCodes },
      references: terminalReferences(
        candidate.informationId,
        claim.informationId,
      ),
    },
  );
}

async function finishDelivery(
  terminal: DeepReadonly<InformationAtom>,
  delivered: boolean,
  atoms: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const request = outgoingStatusTarget(terminal, atoms);
  const turn = (request?.payload as any)?.turn;
  if (request === undefined || turn === undefined) return;
  const candidate = atoms.find(
    (atom) => atom.informationId === turn.candidateInformationId,
  );
  const claim = atoms.find(
    (atom) => atom.informationId === turn.claimInformationId,
  );
  if (candidate === undefined || claim === undefined) return;
  if ((claim.payload as any).candidateInformationId !== candidate.informationId)
    throw new Error("Delivery terminal references an inconsistent turn");
  const base = {
    candidateInformationId: candidate.informationId,
    claimInformationId: claim.informationId,
    scopeKey: (candidate.payload as any).scopeKey,
  };
  if (delivered) {
    await context.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnCompletedInformationKind,
      {
        payload: {
          ...base,
          deliveryTerminalInformationId: terminal.informationId,
        },
        references: terminalReferences(
          candidate.informationId,
          claim.informationId,
        ),
      },
    );
  } else {
    await context.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnFailedInformationKind,
      {
        payload: { ...base, reason: "delivery-failed" },
        references: terminalReferences(
          candidate.informationId,
          claim.informationId,
        ),
      },
    );
  }
}

async function failOpenTurns(
  terminal: DeepReadonly<InformationAtom>,
  reason: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const affectedCandidateIds = traceCandidateIds(terminal, atoms);
  const byId = new Map(atoms.map((atom) => [atom.informationId, atom]));
  const statusTarget = terminal.references
    .filter(({ relation }) => relation === "core:status-of")
    .map(({ informationId }) => byId.get(informationId))
    .find((atom) => atom !== undefined);
  const effectiveReason =
    reason === "execution-exhausted" &&
    statusTarget?.kind === inboundTextInformationKind.kind &&
    String((terminal.payload as any).subscriptionId).includes("identity")
      ? "identity-exhausted"
      : reason;
  const candidates = atoms.filter(
    ({ kind, informationId }) =>
      kind === turnCandidateInformationKind.kind &&
      affectedCandidateIds.has(informationId),
  );
  for (const candidate of candidates) {
    const claim = claimForCandidate(candidate.informationId, atoms);
    if (claim === undefined || turnTerminalFor(candidate.informationId, atoms))
      continue;
    const map = new Map(atoms.map((atom) => [atom.informationId, atom]));
    const runtimeContext = referenced(candidate, "core:context", map)[0];
    if (runtimeContext === undefined) continue;
    await context.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnFailedInformationKind,
      {
        payload: {
          candidateInformationId: candidate.informationId,
          claimInformationId: claim.informationId,
          scopeKey: (candidate.payload as any).scopeKey,
          reason: effectiveReason,
        },
        references: terminalReferences(
          candidate.informationId,
          claim.informationId,
        ),
        contextInformationId: runtimeContext.informationId,
      },
    );
  }
}

function traceCandidateIds(
  terminal: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  const byId = new Map(atoms.map((atom) => [atom.informationId, atom]));
  const visited = new Set<string>();
  const candidates = new Set<string>();
  const queue = terminal.references
    .filter(({ relation }) => relation === "core:status-of")
    .map(({ informationId }) => informationId);
  while (queue.length > 0) {
    const informationId = queue.shift()!;
    if (visited.has(informationId)) continue;
    visited.add(informationId);
    const atom = byId.get(informationId);
    if (atom === undefined) continue;
    if (atom.kind === turnCandidateInformationKind.kind) {
      candidates.add(atom.informationId);
      continue;
    }
    for (const reference of atom.references) {
      if (
        reference.relation === "core:caused-by" ||
        reference.relation === "core:status-of" ||
        reference.relation === "agent:turn-claim" ||
        reference.relation === "agent:turn-candidate"
      )
        queue.push(reference.informationId);
    }
  }
  for (const atom of atoms) {
    if (
      atom.kind === turnCandidateInformationKind.kind &&
      ((atom.payload as any).sourceInformationIds as string[]).some((id) =>
        visited.has(id),
      )
    )
      candidates.add(atom.informationId);
  }
  return candidates;
}

async function traceTurnCandidates(
  ledger: InformationSelectorLedger,
  starts: readonly DeepReadonly<InformationAtom>[],
  remember: (
    atoms: readonly DeepReadonly<InformationAtom>[],
  ) => readonly DeepReadonly<InformationAtom>[],
) {
  const visited = new Map<string, DeepReadonly<InformationAtom>>();
  let frontier = [...starts];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const current = frontier.filter(
      ({ informationId }) => !visited.has(informationId),
    );
    if (current.length === 0) break;
    for (const atom of current) visited.set(atom.informationId, atom);
    const next = (
      await Promise.all(
        current.flatMap((atom) =>
          [
            "core:caused-by",
            "core:status-of",
            "agent:turn-claim",
            "agent:turn-candidate",
          ].map((relation) =>
            related(ledger, atom.informationId, relation, "outgoing", 10),
          ),
        ),
      )
    ).flat();
    remember(next);
    frontier = next;
  }
  return [...visited.values()].filter(
    ({ kind }) => kind === turnCandidateInformationKind.kind,
  );
}

async function supersedeCandidate(
  candidate: DeepReadonly<InformationAtom>,
  claim: DeepReadonly<InformationAtom>,
  replacementCandidateInformationId: string,
  contextInformationId: string,
  context: InformationModuleHandlerContext,
) {
  await context.commitTerminal(
    "agent.turn.terminal",
    candidate.informationId,
    turnSupersededInformationKind,
    {
      payload: {
        candidateInformationId: candidate.informationId,
        claimInformationId: claim.informationId,
        scopeKey: (candidate.payload as any).scopeKey,
        replacementCandidateInformationId,
      },
      references: terminalReferences(
        candidate.informationId,
        claim.informationId,
      ),
      contextInformationId,
    },
  );
}

import {
  hydrateCandidate,
  candidatesForClaims,
  related,
} from "./state-query.js";

import {
  TURN_TERMINAL_KINDS,
  referenced,
  sameScope,
  sameDeliveryScope,
  identityTerminalFor,
  hasExhaustedStatus,
  turnTerminalFor,
  claimForCandidate,
  outgoingStatusTarget,
  terminalReferences,
  assertTurnLink,
  compareCandidates,
  compareClaims,
  uniqueAtoms,
  copyOptionalIdentity,
  assessInputBacklog,
} from "./turn-state.js";
