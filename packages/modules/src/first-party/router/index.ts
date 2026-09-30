/**
 * 候选新旧由 Selector 的账本注册顺序确定；相同/迟到业务时间及随机 UUID 不改变消费先后。
 * Light 的 message 决策只传目标与冻结引用。
 * manifest 声明 Light 模板；调用 compileLightPrompt 时传入装配阶段加载的 default/local 文本，不再使用代码内默认值。
 * settings schema 的公开中文元数据供管理表单使用，运行时与保存共用约束。
 * 管理端批准的跨会话 candidate 由宿主直接认领，不再触发 Light；其 delivery 仍使用本模块统一 turn 终态。
 * Selector 只遍历开放 candidate 及最近 claim；恢复旧积压时每 scope 只推进一次合并观察。
 * 在线 Router 编排器。所有推进都由可重放 Information 事实驱动；模块不保存
 * per-chat 状态，也不依赖订阅安装顺序。
 * createRouterModule 注入投递/模型失败 kind，返回声明订阅的模块；settings schema
 * 校验 Focus、时效与安全策略。state/memory selector 从账本读取因果链及记忆，冻结完整输入。
 * Light 在模型结构修复阶段检查本轮动作边界；同协议重放沿持久化请求复用 Prompt 和上下文，防止迟到历史触发第二次任务。
 * 规划前使用冻结的本轮输入与聊天历史；未完成的记忆模块不提供额外召回。
 * 宿主 conversation 能力冻结背景和候选；跨会话获胜决策交给 route 复核，失败关闭当前 turn，不回退发送。
 * dispatchDecision 仅将独立 Light 的获胜 message 结果按 claim 注册一次意图，末条输入决定目标；
 * turn 标识及引用保留完整冻结上下文，正文生成交给 composer。wait/silent 与失败路径
 * 写入等待或终态；registerOnce/commitTerminal 保证重放幂等，模型 I/O 经宿主 capability 执行，平台 I/O 由 delivery 层负责。
 * 展示契约：Manifest 直接提供中文名称、摘要及输入输出职责，供 Inspection 与 WebUI 展示。
 * inspection 声明本模块的只读机制、领域数据和历史视图，由 Host/Server 投影给开发者控制台。
 */
import { firstPartyInspection } from "../inspection.js";
import type { RawContextAccess } from "@kaguya/memory";
import { frozenRawContextInformationKind } from "./raw-context.js";
import { focusOpened, focusRenewed, focusKinds } from "./focus-facts.js";
import { focusStateSelector, createRouterFocusSubscriptions } from "./focus.js";
import {
  oneShotDueInformationKind,
  oneShotScheduleCapability,
} from "@kaguya/scheduler";
import {
  lightBootstrapPolicyDeclaration,
  lightPlatformPolicyDeclarations,
  lightTemplateDeclaration,
} from "../../prompt-declarations.js";
import { isImmediateObservation, scopeOf } from "../heartbeat/observation.js";
import {
  type MessageAuthorization,
  conversationContextInformationKind,
} from "../message-authorization.js";
import {
  compileLightPrompt,
  lightActionSchema,
  lightActionSchemaForTurn,
  lightContextSelector,
  lightDecisionInformationKind,
  LIGHT_TASK_ID,
} from "./light.js";
import type { AgentIdentity, ModelTaskCapability } from "../heavy/index.js";
import type { ModuleCapability } from "@kaguya/sdk";

import {
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  z,
} from "@kaguya/schema";
import {
  defineInformationModule,
  defineModuleDiagnostic,
  defineInformationSelector,
  onInformation,
  type InformationKindDefinition,
  type InformationModuleHandlerContext,
  type InformationSelectorLedger,
} from "@kaguya/sdk";
import { buildTurnBootstrap } from "./bootstrap.js";
import {
  selectActivePersonProfiles,
  type ActivePersonProfiles,
} from "../person-profile.js";

import {
  observationWakeInformationKind,
  inboundTextInformationKind,
  personContextCompletedInformationKind,
  messageIntentRequestedInformationKind,
  heavyResponseSilentInformationKind,
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
} from "../information-kinds.js";

type AnyKind = InformationKindDefinition<string, any>;

export const rawMemoryBarrierFailureDiagnostic = defineModuleDiagnostic({
  event: "router.memory.barrier.failed",
  message: "Raw Memory projection failed; turn remains pending",
  level: "error",
  payloadSchema: z
    .object({
      errorType: z.string().min(1),
      turnInformationId: z.string().min(1),
    })
    .strict(),
  project: (payload) => ({ ...payload }),
});

interface LightDispatch {
  readonly action: "message" | "wait" | "silent";
  readonly candidateInformationId: string;
  readonly claimInformationId: string;
  readonly turnContextInformationId: string;
  readonly source: any;
  readonly attempt: number;
  readonly totalWaitBudget: number;
  readonly reasonCodes: readonly string[];
  readonly dueAt?: string;
  readonly delayMs?: number;
  readonly wakePolicy?: "recheckAt" | "cooldown";
}

export interface CreateRouterModuleOptions {
  readonly modelTaskCapability: ModuleCapability<ModelTaskCapability>;
  readonly rawContextCapability: ModuleCapability<RawContextAccess>;
  readonly messageAuthorizationCapability?: ModuleCapability<MessageAuthorization>;
  readonly agentIdentity: AgentIdentity;
  readonly activePersonProfiles?: ActivePersonProfiles;
  readonly lightTemplate: string;
  readonly lightBootstrapPolicy: string;
  readonly lightPlatformPolicies?: Readonly<
    Record<"default" | "qq" | "web", string>
  >;
  readonly deliveryDeliveredInformationKind: AnyKind;
  readonly deliveryFailedInformationKind: AnyKind;
  readonly modelTaskFailedInformationKind: AnyKind;
  readonly modelTaskCancelledInformationKind: AnyKind;
  readonly modelTaskRequestedInformationKind?: AnyKind;
  readonly executionExhaustedInformationKind: AnyKind;
}

export const routerSettingsSchema = z
  .object({
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
        "最近一条输入超过此年龄时标记为积压并交由 Light 判断，单位毫秒。",
      public: true,
      default: 120000,
    }),
    lightInterruptMaxConsecutiveCount: z
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
export type RouterSettings = z.infer<typeof routerSettingsSchema>;

const lightInterruptSelector = defineInformationSelector({
  selectorId: "agent.router.light-interrupt",
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
    const candidateStatuses = add(
      await ledger.related({
        from: [candidate.informationId],
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
    for (const attention of [...claimStatuses, ...candidateStatuses].filter(
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

export const routerStateSelector = defineInformationSelector({
  selectorId: "agent.router.state",
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
        anchors = await candidatesForClaims(ledger, recoveryClaims, remember);
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
    } else if (sourceAtom.kind === heavyResponseSilentInformationKind.kind) {
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
      anchors = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "core:status-of",
          "outgoing",
        ),
      ).filter(({ kind }) => kind === turnCandidateInformationKind.kind);
    } else if (sourceAtom.kind === turnContextCompletedInformationKind.kind) {
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
      const inboundClaims = (
        await Promise.all(
          statusTargets
            .filter(({ kind }) => kind === inboundTextInformationKind.kind)
            .map((inbound) =>
              related(
                ledger,
                inbound.informationId,
                "core:uses-context",
                "incoming",
                1_000,
              ),
            ),
        )
      )
        .flat()
        .filter((atom) => atom.kind === turnClaimedInformationKind.kind);
      remember(inboundClaims);
      const inboundCandidates = await candidatesForClaims(
        ledger,
        inboundClaims,
        remember,
      );
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
    // 水合会先加入触发候选，再补旧 claim；Map 插入顺序不能代表账本先后。
    // 只重排已经选中的候选，分页保留全部身份，不扩张读取范围或按事件时间排序。
    const candidateIds = [...selected.values()]
      .filter((atom) => atom.kind === turnCandidateInformationKind.kind)
      .map((atom) => atom.informationId);
    if (candidateIds.length === 0) return [...selected.keys()];
    const orderedCandidateIds: string[] = [];
    let afterInformationId: string | undefined;
    for (;;) {
      const page = await ledger.find({
        informationIds: candidateIds,
        registrationOrder: true,
        order: "asc",
        limit: 1000,
        ...(afterInformationId ? { afterInformationId } : {}),
      });
      orderedCandidateIds.push(...page.map((atom) => atom.informationId));
      if (page.length < 1000) break;
      afterInformationId = page.at(-1)!.informationId;
    }
    if (orderedCandidateIds.length !== candidateIds.length)
      throw new Error("Router candidate registration order is incomplete");
    const candidatesSet = new Set(candidateIds);
    return [
      ...[...selected.keys()].filter((id) => !candidatesSet.has(id)),
      ...orderedCandidateIds,
    ];
  },
});

export function createRouterModule(options: CreateRouterModuleOptions) {
  const deliveryKinds = [
    options.deliveryDeliveredInformationKind,
    options.deliveryFailedInformationKind,
  ] as const;
  const modelTaskFailureKinds = [
    options.modelTaskFailedInformationKind,
    options.modelTaskCancelledInformationKind,
  ] as const;
  const maybeInterruptLight = async (
    context: InformationModuleHandlerContext,
    settings: DeepReadonly<RouterSettings>,
  ): Promise<boolean> => {
    const atoms = await context.select(lightInterruptSelector);
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
    if (turnTerminalFor(candidate.informationId, atoms)) return false;
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
        (atom.payload as any).taskId === LIGHT_TASK_ID,
    );
    if (interrupted) {
      for (const requested of requests) {
        await context.use(options.modelTaskCapability).cancel({
          requestedInformationId: requested.informationId,
          reason: "New message interrupted Light",
        });
      }
      return true;
    }
    const frozen = atoms.find(
      (atom) =>
        atom.kind === turnContextCompletedInformationKind.kind &&
        (atom.payload as any).claimInformationId === claim.informationId,
    );
    const attention = atoms.find(
      (atom) =>
        atom.kind === attentionArousalCompletedInformationKind.kind &&
        (atom.payload as any).candidateInformationId ===
          candidate.informationId &&
        (atom.payload as any).outcome === "observe",
    );
    if (!frozen || !attention) return false;
    const attempt = Number((candidate.payload as any).rebuildAttempt ?? 0);
    if (attempt >= settings.lightInterruptMaxConsecutiveCount) return false;
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
      "agent.router.turn.decision",
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
      "agent.router.turn.terminal",
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
        reason: "New message interrupted Light",
      });
    }
    return true;
  };
  const module = defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "2.0.0",
      definitionId: "agent.router",
      inspection: firstPartyInspection["agent.router"],
      displayName: "Router 路由与关注",
      summary: "协调回合认领、上下文冻结、Light 决策、Focus 租约和回合终态。",
      description:
        "只在非语义注意力观察决定 observe 后消费候选，按注册水位读取未读并经身份屏障冻结上下文，再请求内部 Light 选择发言、等待或静默；维护 Focus 租约，输出消息意图、等待请求和回合终态，不执行平台传输。",
      settingsSchema: routerSettingsSchema,
      diagnostics: [rawMemoryBarrierFailureDiagnostic],
      promptTemplates: [
        lightTemplateDeclaration,
        lightBootstrapPolicyDeclaration,
        ...lightPlatformPolicyDeclarations,
      ],
      consumes: [
        focusOpened,
        focusRenewed,
        oneShotDueInformationKind,
        inboundTextInformationKind,
        observationWakeInformationKind,
        turnCandidateInformationKind,
        personContextCompletedInformationKind,
        turnClaimedInformationKind,
        attentionArousalCompletedInformationKind,
        turnContextCompletedInformationKind,
        lightDecisionInformationKind,
        heavyResponseSilentInformationKind,
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
        ...focusKinds,
        lightDecisionInformationKind,
        turnClaimedInformationKind,
        turnStartedInformationKind,
        turnDecisionSupersededInformationKind,
        turnDecisionInterruptedInformationKind,
        turnContextCompletedInformationKind,
        frozenRawContextInformationKind,
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
        focusStateSelector,
        routerStateSelector,
        lightInterruptSelector,
        lightContextSelector,
      ],
      promptRenderers: [],
      requires: [
        oneShotScheduleCapability,
        options.modelTaskCapability,
        options.rawContextCapability,
        ...(options.messageAuthorizationCapability
          ? [options.messageAuthorizationCapability]
          : []),
      ],
      provides: [],
    },
    create: ({ settings, activation }, lifecycle) => ({
      provisions: [],
      describeStartup: () => ({
        summary: "Information DAG router ready",
        fields: { identityBarrier: "required", plannerRounds: 1 },
      }),
      subscriptions: [
        ...createRouterFocusSubscriptions(activation, lifecycle),
        onInformation(
          inboundTextInformationKind,
          {
            subscriptionId: "agent.router.interrupt.inbound",
            delivery: "durable",
          },
          async (_atom, context) => {
            await maybeInterruptLight(context, settings);
          },
        ),
        ...(options.modelTaskRequestedInformationKind
          ? [
              onInformation(
                options.modelTaskRequestedInformationKind,
                {
                  subscriptionId: "agent.router.interrupt.requested",
                  delivery: "durable",
                },
                async (_atom, context) => {
                  await maybeInterruptLight(context, settings);
                },
              ),
            ]
          : []),
        ...[
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
              subscriptionId: `agent.router.progress.${definition.kind}`,
              delivery: "durable",
            },
            async (_atom, context) => {
              const state = await context.select(routerStateSelector);
              await progressCandidates(
                state,
                settings,
                options.activePersonProfiles,
                context,
              );
            },
          ),
        ),
        ...[
          attentionArousalCompletedInformationKind,
          turnContextCompletedInformationKind,
        ].map((definition) =>
          onInformation(
            definition as AnyKind,
            {
              subscriptionId: `agent.router.observe.${definition.kind}`,
              delivery: "durable",
              ...(definition.kind === turnContextCompletedInformationKind.kind
                ? { retryForever: true, retryDelayMs: 5_000 }
                : {}),
            },
            async (sourceAtom, context) => {
              if (
                sourceAtom.kind ===
                attentionArousalCompletedInformationKind.kind
              ) {
                if (sourceAtom.payload.outcome !== "observe") return;
                const state = await context.select(routerStateSelector);
                await progressCandidates(
                  state,
                  settings,
                  options.activePersonProfiles,
                  context,
                );
                return;
              }
              const state = await context.select(routerStateSelector);
              const decision = state.find(
                (atom) =>
                  atom.kind === attentionArousalCompletedInformationKind.kind &&
                  atom.payload.candidateInformationId ===
                    sourceAtom.payload.candidateInformationId &&
                  atom.payload.outcome === "observe",
              );
              const candidate = state.find(
                (atom) =>
                  atom.kind === turnCandidateInformationKind.kind &&
                  atom.informationId ===
                    sourceAtom.payload.candidateInformationId,
              );
              const claim = state.find(
                (atom) =>
                  atom.kind === turnClaimedInformationKind.kind &&
                  atom.informationId === sourceAtom.payload.claimInformationId,
              );
              if (!decision || !candidate || !claim) return;
              if (await maybeInterruptLight(context, settings)) return;
              const gate = {
                ...decision.payload,
                claimInformationId: claim.informationId,
                turnContextInformationId: sourceAtom.informationId,
                source: sourceAtom.payload.source,
                attempt: candidate.payload.attempt,
                totalWaitBudget: candidate.payload.totalWaitBudget,
              } as any;
              if (turnTerminalFor(gate.candidateInformationId, state)) return;
              if (
                state.some(
                  (atom) =>
                    atom.kind === turnDecisionSupersededInformationKind.kind &&
                    atom.payload.claimInformationId === gate.claimInformationId,
                )
              )
                return;
              const blockedReasons = [
                ...(sourceAtom.payload.muted ? ["muted"] : []),
                ...(!sourceAtom.payload.safe ? ["unsafe"] : []),
                ...(!sourceAtom.payload.destinationAvailable
                  ? ["no-destination"]
                  : []),
              ];
              if (blockedReasons.length) {
                await dispatchDecision(
                  {
                    action: "silent",
                    candidateInformationId: gate.candidateInformationId,
                    claimInformationId: gate.claimInformationId,
                    turnContextInformationId: gate.turnContextInformationId,
                    source: gate.source,
                    attempt: gate.attempt,
                    totalWaitBudget: gate.totalWaitBudget,
                    reasonCodes: blockedReasons,
                  },
                  state,
                  context,
                );
                return;
              }
              let selected: DeepReadonly<InformationAtom>[] = [
                ...(await context.select(lightContextSelector)),
              ];
              const hasPersistedPrompt = selected.some(
                (atom) =>
                  atom.kind === "core.model.task.requested" &&
                  atom.payload.taskId === LIGHT_TASK_ID &&
                  (atom.payload.activation as { instanceId?: string })
                    ?.instanceId === activation.instanceId &&
                  (atom.payload.activation as { definitionId?: string })
                    ?.definitionId === activation.definitionId,
              );
              let rawAtom = selected.find(
                (atom) =>
                  atom.kind === frozenRawContextInformationKind.kind &&
                  atom.payload.turnInformationId === sourceAtom.informationId,
              );
              if (!rawAtom && !hasPersistedPrompt) {
                let frozenRaw;
                try {
                  frozenRaw = await context.use(options.rawContextCapability).freeze({
                        turnInformationId: sourceAtom.informationId,
                        asOf: sourceAtom.payload.backlog.evaluatedAt,
                        scope: {
                          platform: sourceAtom.payload.source.platform,
                          adapterId: sourceAtom.payload.source.adapterId,
                          destination: sourceAtom.payload.source.destination,
                        },
                        unreadInformationIds: sourceAtom.payload.inputs.map(
                          (input: any) => input.informationId,
                        ),
                      });
                } catch (error) {
                  await context.report(rawMemoryBarrierFailureDiagnostic, {
                    errorType:
                      error instanceof Error ? error.name : "UnknownError",
                    turnInformationId: sourceAtom.informationId,
                  });
                  throw error;
                }
                rawAtom =
                  frozenRaw &&
                  (await context.registerOnce(
                    "agent.router.memory.context.frozen",
                    sourceAtom.informationId,
                    frozenRawContextInformationKind,
                    {
                      payload: {
                        turnInformationId: sourceAtom.informationId,
                        global: {
                          text: frozenRaw.global.text,
                          informationIds: [...frozenRaw.global.informationIds],
                        },
                        currentScope: {
                          text: frozenRaw.currentScope.text,
                          informationIds: [
                            ...frozenRaw.currentScope.informationIds,
                          ],
                        },
                        overBudget: frozenRaw.overBudget,
                        characterCount: frozenRaw.characterCount,
                      },
                      contextInformationId: sourceAtom.references.find(
                        (r) => r.relation === "core:context",
                      )!.informationId,
                    },
                  ));
                if (rawAtom) selected.push(rawAtom);
              }
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
              const runtimeContextId = sourceAtom.references.find(
                (reference) => reference.relation === "core:context",
              )!.informationId;
              const persisted = selected.find(
                (atom) =>
                  atom.kind === "core.model.task.requested" &&
                  atom.payload.taskId === LIGHT_TASK_ID &&
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
                        throw new Error("Missing persisted Light context");
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
                    taskId: LIGHT_TASK_ID,
                    outputMode: "object",
                    outputSchema: lightActionSchemaForTurn({
                      inputs: (turn.payload as any).inputs,
                      attempt: gate.attempt,
                      totalWaitBudget: gate.totalWaitBudget,
                    }),
                    allowedTiers: ["light"],
                  },
                  sourceInformationId: sourceAtom.informationId,
                  contextInformationId: runtimeContextId,
                  activation,
                  selectionPolicy: { tier: "light" },
                  prompt: persisted
                    ? (persisted.payload.prompt as unknown as CompiledPrompt)
                    : compileLightPrompt(
                        options.agentIdentity,
                        taskAtoms,
                        turn,
                        options.lightTemplate,
                        options.lightPlatformPolicies,
                        options.lightBootstrapPolicy,
                      ),
                  contextAtoms: taskAtoms,
                });
              const parsed =
                result.status === "completed"
                  ? lightActionSchema.safeParse(result.output)
                  : undefined;
              let action: z.infer<
                typeof lightDecisionInformationKind.payloadSchema
              >["action"] = parsed?.success
                ? parsed.data
                : { action: "silent", reason: "light-unavailable" };
              if (
                action.action === "wait" &&
                gate.attempt >= gate.totalWaitBudget
              )
                action = { action: "silent", reason: "wait-budget-exhausted" };
              const winner = await context.commitTerminal(
                "agent.router.turn.decision",
                gate.claimInformationId,
                lightDecisionInformationKind,
                {
                  payload: {
                    turnContextInformationId: sourceAtom.informationId,
                    action,
                  },
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
                winner.kind !== lightDecisionInformationKind.kind ||
                winner.payload.turnContextInformationId !==
                  sourceAtom.informationId
              )
                return;
              action = lightDecisionInformationKind.payloadSchema.parse(
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
                    "agent.router.turn.terminal",
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
            },
          ),
        ),
        onInformation(
          lightDecisionInformationKind,
          {
            subscriptionId: "agent.router.dispatch-light",
            delivery: "durable",
          },
          async (plan, context) => {
            const state = await context.select(routerStateSelector);
            const turn = state.find(
              (atom) =>
                atom.kind === turnContextCompletedInformationKind.kind &&
                atom.informationId === plan.payload.turnContextInformationId,
            );
            if (!turn) return;
            const candidate = state.find(
              (atom) =>
                atom.kind === turnCandidateInformationKind.kind &&
                atom.informationId === turn.payload.candidateInformationId,
            );
            const claim = state.find(
              (atom) =>
                atom.kind === turnClaimedInformationKind.kind &&
                atom.informationId === turn.payload.claimInformationId,
            );
            if (!candidate || !claim) return;
            const action = plan.payload.action;
            const dispatch: LightDispatch = {
              action: action.action,
              candidateInformationId: candidate.informationId,
              claimInformationId: claim.informationId,
              turnContextInformationId: turn.informationId,
              source: turn.payload.source,
              attempt: Number(candidate.payload.attempt),
              totalWaitBudget: Number(candidate.payload.totalWaitBudget),
              reasonCodes: [action.reason],
              ...(action.action === "wait"
                ? {
                    delayMs: action.waitSeconds * 1000,
                    dueAt: new Date(
                      Date.parse(plan.occurredAt) + action.waitSeconds * 1000,
                    ).toISOString(),
                  }
                : {}),
            };
            await dispatchDecision(dispatch, state, context);
          },
        ),
        onInformation(
          heavyResponseSilentInformationKind,
          {
            subscriptionId: "agent.router.heavy-silent",
            delivery: "durable",
          },
          async (silent, context) => {
            const state = await context.select(routerStateSelector);
            const provenance = silent.payload.turn;
            const candidate = state.find(
              (atom) =>
                atom.kind === turnCandidateInformationKind.kind &&
                atom.informationId === provenance.candidateInformationId,
            );
            const claim = state.find(
              (atom) =>
                atom.kind === turnClaimedInformationKind.kind &&
                atom.informationId === provenance.claimInformationId,
            );
            const turn = state.find(
              (atom) =>
                atom.kind === turnContextCompletedInformationKind.kind &&
                atom.informationId === provenance.contextInformationId,
            );
            if (!candidate || !claim || !turn)
              throw new Error("Heavy silent references an incomplete turn");
            assertTurnLink(candidate, claim, turn);
            if (
              !silent.references.some(
                (reference) =>
                  reference.relation === "core:uses-context" &&
                  reference.informationId ===
                    silent.payload.intentInformationId,
              )
            )
              throw new Error("Heavy silent must reference its message intent");
            await context.commitTerminal(
              "agent.router.turn.terminal",
              candidate.informationId,
              turnSilentInformationKind,
              {
                payload: {
                  candidateInformationId: candidate.informationId,
                  claimInformationId: claim.informationId,
                  scopeKey: String(candidate.payload.scopeKey),
                  reasonCodes: ["heavy-declined"],
                },
                references: terminalReferences(
                  candidate.informationId,
                  claim.informationId,
                ),
              },
            );
          },
        ),
        ...deliveryKinds.map((definition) =>
          onInformation(
            definition,
            {
              subscriptionId: `agent.router.delivery.${definition.kind}`,
              delivery: "durable",
            },
            async (terminal, context) => {
              const state = await context.select(routerStateSelector);
              await finishDelivery(
                terminal,
                definition === options.deliveryDeliveredInformationKind,
                state,
                context,
              );
              await progressCandidates(
                state,
                settings,
                options.activePersonProfiles,
                context,
              );
            },
          ),
        ),
        ...modelTaskFailureKinds.map((definition) =>
          onInformation(
            definition,
            {
              subscriptionId: `agent.router.model-task.${definition.kind}`,
              delivery: "durable",
            },
            async (terminal, context) => {
              const state = await context.select(routerStateSelector);
              if (terminal.payload.taskId === LIGHT_TASK_ID) return;
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
            subscriptionId: "agent.router.execution-exhausted",
            delivery: "durable",
          },
          async (exhausted, context) => {
            const state = await context.select(routerStateSelector);
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
  settings: DeepReadonly<RouterSettings>,
  activePersonProfiles: ActivePersonProfiles | undefined,
  context: InformationModuleHandlerContext,
) {
  const candidates = atoms.filter(
    (a) =>
      a.kind === turnCandidateInformationKind.kind &&
      !turnTerminalFor(a.informationId, atoms) &&
      a.payload.managementAuthorizationId === undefined &&
      atoms.some(
        (decision) =>
          decision.kind === attentionArousalCompletedInformationKind.kind &&
          decision.payload.candidateInformationId === a.informationId &&
          decision.payload.outcome === "observe",
      ),
  );
  const scopes = new Set(candidates.map((a) => String(a.payload.scopeKey)));
  for (const scope of scopes) {
    // routerStateSelector 保证候选子序列按持久注册位置递增。
    const open = candidates.filter((a) => a.payload.scopeKey === scope);
    const winner = open.at(-1)!;
    await progressCandidate(
      winner,
      atoms,
      settings,
      activePersonProfiles,
      context,
    );
    if (open.length < 2) continue;
    const refreshed = await context.select(routerStateSelector);
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
  settings: DeepReadonly<RouterSettings>,
  activePersonProfiles: ActivePersonProfiles | undefined,
  context: InformationModuleHandlerContext,
) {
  const map = new Map(atoms.map((atom) => [atom.informationId, atom]));
  if (turnTerminalFor(candidate.informationId, atoms) !== undefined) return;
  const payload = { ...candidate.payload } as any;
  if (payload.managementAuthorizationId !== undefined) return;
  const runtimeContext = referenced(candidate, "core:context", map)[0];
  if (runtimeContext === undefined) return;
  const scopedInbounds = atoms.filter(
    (atom) =>
      atom.kind === inboundTextInformationKind.kind &&
      sameScope((atom.payload as any).source, {
        platform: payload.platform,
        adapterId: payload.adapterId,
        destination: payload.destination,
      }),
  );
  const upperIndex = scopedInbounds.findIndex(
    (atom) => atom.informationId === payload.unreadThroughInformationId,
  );
  if (upperIndex < 0) return;
  let effectiveSourceInformationIds = scopedInbounds
    .slice(
      Math.max(0, upperIndex - Number(payload.unreadCount) + 1),
      upperIndex + 1,
    )
    .map((atom) => atom.informationId);
  if (effectiveSourceInformationIds.length !== Number(payload.unreadCount))
    return;

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
    if (atoms.indexOf(candidate) <= atoms.indexOf(latestCandidate)) {
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
        "agent.router.turn.decision",
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
        "agent.router.turn.terminal",
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
    "agent.router.turn.claim",
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
  }

  await context.registerOnce(
    "agent.router.turn.started",
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
        "agent.router.turn.terminal",
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
  const personProfiles = frozenContext
    ? (((frozenContext.payload as any).personProfiles ?? []) as ReturnType<
        typeof selectActivePersonProfiles
      >)
    : selectActivePersonProfiles(
        completeInputs.map(({ inbound, identity }) => ({
          source: (inbound.payload as any).source,
          personInformationId:
            (identity.payload as any).status === "complete" &&
            (identity.payload as any).scopeMode === "canonical"
              ? (identity.payload as any).personInformationId
              : undefined,
        })),
        (completeInputs.at(-1)!.inbound.payload as any).source.destination
          ?.kind === "group",
        activePersonProfiles,
      );
  const personNames = frozenContext
    ? (((frozenContext.payload as any).personNames ?? []) as {
        personInformationId: string;
        speakerKey: string;
        initialName: string;
        platform?: string;
        adapterId?: string;
      }[])
    : [
        ...new Map([
          ...completeInputs.flatMap(({ inbound, identity }) => {
            const resolved = identity.payload as any;
            if (
              resolved.status !== "complete" ||
              resolved.scopeMode !== "canonical" ||
              !resolved.personInformationId
            )
              return [];
            const inputSource = (inbound.payload as any).source;
            const speakerKey = `speaker:${inputSource.senderId}`;
            return [
              [
                JSON.stringify([
                  inputSource.platform,
                  inputSource.adapterId,
                  inputSource.senderId,
                ]),
                {
                  personInformationId: String(resolved.personInformationId),
                  speakerKey,
                  platform: inputSource.platform,
                  adapterId: inputSource.adapterId,
                  initialName:
                    activePersonProfiles?.initialNames?.get(
                      String(resolved.personInformationId),
                    ) ||
                    String(
                      resolved.initialName ||
                        inputSource.sender?.nickname ||
                        inputSource.senderId,
                    ),
                },
              ] as const,
            ];
          }),
          ...personProfiles.flatMap((profile) => {
            const initialName = activePersonProfiles?.initialNames?.get(
              profile.personInformationId,
            );
            if (!initialName || !profile.platform || !profile.adapterId)
              return [];
            return [
              [
                JSON.stringify([
                  profile.platform,
                  profile.adapterId,
                  profile.speakerKey.slice("speaker:".length),
                ]),
                {
                  personInformationId: profile.personInformationId,
                  speakerKey: profile.speakerKey,
                  platform: profile.platform,
                  adapterId: profile.adapterId,
                  initialName,
                },
              ] as const,
            ];
          }),
        ]).values(),
      ];
  const last = completeInputs.at(-1)!;
  const source = (last.inbound.payload as any).source;
  const text = completeInputs
    .map(({ inbound }) => (inbound.payload as any).text as string)
    .join("\n");
  const signals = new Set<string>(payload.signals);
  const mentionedSelf =
    signals.has("mention-self") || signals.has("mention-all");
  const repliedToSelf = signals.has("reply-self");
  const asOfMs = Date.parse(payload.asOf);
  const isGroup = source.destination?.kind === "group";
  // Web and other point-to-agent transports are direct conversations just
  // like platform private messages; only an explicit group uses group policy.
  const isPrivate = !isGroup;
  const safe = completeInputs.every(
    ({ identity }) => (identity.payload as any).status !== "failed",
  );
  const observation = atoms.find(
    (atom) =>
      atom.kind === attentionArousalCompletedInformationKind.kind &&
      atom.payload.candidateInformationId === candidate.informationId &&
      atom.payload.outcome === "observe",
  );
  let focus =
    isGroup && observation?.payload.focusState === "active"
      ? referenced(observation, "core:uses-context", map).find(
          (atom) =>
            atom.informationId === observation.payload.focusInformationId,
        )
      : undefined;
  const directInput =
    mentionedSelf || repliedToSelf
      ? (completeInputs.find(({ inbound }) =>
          isImmediateObservation((inbound.payload as any).source),
        ) ?? completeInputs.at(-1))
      : undefined;
  if (isGroup && directInput) {
    const direct = directInput.inbound;
    const focusStartedAt = context.now().toISOString();
    const opened = await context.registerOnce(
      "agent.router.focus.open",
      direct.informationId,
      focusOpened,
      {
        payload: {
          scopeKey: payload.scopeKey,
          generation: direct.informationId,
          startedAt: focusStartedAt,
          expiresAt: new Date(
            Date.parse(focusStartedAt) + settings.focusIdleMs,
          ).toISOString(),
          reason: mentionedSelf ? "mentioned-self" : "replied-to-self",
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
    focus = opened;
  }
  const backlog = assessInputBacklog(
    completeInputs.map(({ inbound }) => inbound.occurredAt),
    context.now().toISOString(),
    settings.staleAfterMs,
  );
  const bootstrap = buildTurnBootstrap(completeInputs, atoms, false, 0);
  const bootstrapEvidenceIds = [
    ...new Set(
      completeInputs.flatMap(({ identity }) => {
        const value = identity.payload as Record<string, unknown>;
        return [value.scopeInformationId, value.personInformationId].filter(
          (id): id is string =>
            typeof id === "string" &&
            atoms.some(({ informationId }) => informationId === id),
        );
      }),
    ),
  ];
  await context.registerOnce(
    "agent.router.turn.context.completed",
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
        observedThroughInformationId: payload.unreadThroughInformationId,
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
        muted: settings.muted,
        safe,
        destinationAvailable: source.destination !== undefined,
        stale:
          Number.isFinite(asOfMs) &&
          Date.parse(payload.firedAt) - asOfMs > settings.staleAfterMs,
        bootstrap,
        ...(personProfiles.length === 0 ? {} : { personProfiles }),
        ...(personNames.length === 0 ? {} : { personNames }),
        attempt: payload.attempt,
        totalWaitBudget: payload.totalWaitBudget,
      } as any,
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
        ...bootstrapEvidenceIds.map((informationId) => ({
          relation: "core:uses-context" as const,
          informationId,
        })),
        ...(focus
          ? [
              {
                relation: "core:uses-context",
                informationId: focus.informationId,
              },
            ]
          : []),
        ...personProfiles.map(({ profileInformationId }) => ({
          relation: "core:uses-context" as const,
          informationId: profileInformationId,
        })),
      ],
      contextInformationId: runtimeContext.informationId,
    },
  );
}

async function dispatchDecision(
  payload: LightDispatch,
  atoms: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
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
  if (payload.action === "message") {
    const targetInput = (turnContext.payload as any).inputs.at(-1);
    if (targetInput === undefined)
      throw new Error("Message decision requires a target turn input");
    await context.registerOnce(
      "agent.router.message-intent",
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
          memoryInformationIds: [],
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
  if (payload.action === "wait") {
    if (payload.dueAt === undefined || payload.delayMs === undefined)
      throw new Error("Wait decision requires dueAt and delayMs");
    const sourceInformationIds = (turnContext.payload as any).inputs.map(
      (input: any) => input.informationId,
    );
    await context.registerOnce(
      "agent.router.wait",
      claim.informationId,
      waitRequestedInformationKind,
      {
        payload: {
          dueAt: payload.dueAt,
          delayMs: payload.delayMs,
          reason: payload.reasonCodes[0] ?? "await-more-context",
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
      "agent.router.turn.terminal",
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
    "agent.router.turn.terminal",
    candidate.informationId,
    turnSilentInformationKind,
    {
      payload: { ...terminalInput, reasonCodes: [...payload.reasonCodes] },
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
      "agent.router.turn.terminal",
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
      "agent.router.turn.terminal",
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
      "agent.router.turn.terminal",
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
    "agent.router.turn.terminal",
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
  identityTerminalFor,
  hasExhaustedStatus,
  turnTerminalFor,
  claimForCandidate,
  outgoingStatusTarget,
  terminalReferences,
  assertTurnLink,
  compareClaims,
  uniqueAtoms,
  copyOptionalIdentity,
  assessInputBacklog,
} from "./turn-state.js";

export { lightActionSchema } from "./light.js";
