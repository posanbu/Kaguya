/**
 * 解析 message composition 时保留可选 tone；跨目标授权和正文确认流程保持原有边界。
 * 功能概述：管理跨会话目录解析、短期候选、目标授权和正文确认，所有批准状态只由可信宿主持有。
 * 五分钟缓存随查询/路由清理，活跃目标授权数量有界；
 * conversation 冻结双投影并限制到当前 adapter 和本轮人物/目标；route 从持久化 Planner 决策创建自动授权，stage 绑定唯一正文。
 * 主要职责：resolve 返回显式结果；authorize 冻结批准说明并创建标准 intent；confirm 绑定精确 assistant；
 * prepare/stage 是 Composer 的窄能力；validateDelivery 对请求因果链、连接代次和正文再次验证。
 * 代码库关系：Server 管理认证路由调用本类，Runtime 注入 Core/目录/生效 allowlist 和授权正文渲染器；不读取模板文件或直接调用 transport。
 * AuthorizedMessagePromptRenderer 只接收授权说明和已冻结的背景变量；prepare 保留其来源引用，未装配渲染器时拒绝生成正文。
 * 输入输出与副作用：持久化授权/确认事实，私有授权表重启失效；目录、白名单或内容变化拒绝；不记录文本或 ID。
 */
import { randomUUID } from "node:crypto";
import type { InformationCore } from "@kaguya/engine";
import { defineInformationSelector } from "@kaguya/sdk";
import {
  z,
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
  type PromptVariable,
} from "@kaguya/schema";
import {
  conversationContextInformationKind,
  turnContextCompletedInformationKind,
  plannerActionSchema,
  messageIntentRequestedInformationKind,
  messageIntentRequestedInformationPayloadSchema,
  targetAuthorizedInformationKind,
  messageConfirmedInformationKind,
  turnCandidateInformationKind,
  turnClaimedInformationKind,
  type MessageAuthorization,
  type MessageTarget,
} from "@kaguya/modules";
import {
  targetKey,
  type TargetDirectory,
  type ReachableTarget,
} from "@kaguya/platform-adapters";
import type { GatewayAllowlist } from "./gateway-allowlist.js";

export const targetQuerySchema = z
  .object({
    mode: z.enum(["id", "name", "description"]),
    value: z.string().trim().min(1).max(1000),
    adapterId: z.string().min(1).optional(),
    kind: z.enum(["group", "private"]).optional(),
  })
  .strict();
export type TargetQuery = z.infer<typeof targetQuerySchema>;
export type TargetResolution =
  | {
      status: "resolved" | "ambiguous";
      candidates: { reference: string; name: string; target: MessageTarget }[];
    }
  | { status: "not-found" | "unavailable" | "unauthorized" };
export type AuthorizedMessagePromptRenderer = (input: {
  readonly automatic: boolean;
  readonly instruction: PromptVariable;
  readonly background?: PromptVariable;
}) => CompiledPrompt;
interface FrozenRoutingTurn {
  candidateInformationId: string;
  claimInformationId: string;
  inputs: {
    informationId: string;
    text: string;
    source: MessageTarget & {
      senderId: string;
      sender?: { card?: string; nickname?: string };
      mentions?: ({ kind: "all" } | { kind: "user"; id: string })[];
    };
    identity: { status: string };
  }[];
}
interface Candidate {
  target: ReachableTarget;
  generation: string;
  expires: number;
}
interface Approval extends Candidate {
  candidateId: InformationId;
  authorizationId: InformationId;
  intentId?: InformationId;
  assistantId?: InformationId;
  text?: string;
  confirmed: boolean;
  automatic?: boolean;
  conversationId?: InformationId;
  confirming?: boolean;
  deliveryId?: InformationId;
}
const selfSelector = defineInformationSelector({
  selectorId: "runtime.target.self",
  select: ({ sourceAtom }) => [sourceAtom.informationId],
});
const causeSelector = defineInformationSelector({
  selectorId: "runtime.target.cause",
  select: async ({ sourceAtom, ledger }) =>
    (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 2,
      })
    ).map((a) => a.informationId),
});
function contextId(atom: DeepReadonly<InformationAtom>): InformationId {
  const refs = atom.references.filter((r) => r.relation === "core:context");
  if (refs.length !== 1) throw new Error("target-authorization-required");
  return refs[0]!.informationId;
}

export class MessageTargetService implements MessageAuthorization {
  readonly #candidates = new Map<string, Candidate>();
  readonly #approvals = new Map<string, Approval>();
  readonly #validatedCrossDeliveries = new Map<InformationId, Approval>();
  readonly #conversations = new Map<
    string,
    Promise<DeepReadonly<InformationAtom>>
  >();
  readonly #routing = new Map<
    string,
    Promise<{ status: "accepted" | "failed"; reason?: string }>
  >();
  readonly #routeCandidates = new Map<string, Map<string, Candidate>>();
  readonly #cacheExpiry = new Map<string, number>();
  #closed = false;
  constructor(
    private readonly core: InformationCore,
    private readonly directory: TargetDirectory | undefined,
    private readonly allowlist: GatewayAllowlist,
    private readonly now = () => new Date(),
    private readonly audit: (event: {
      status: string;
      mode: string;
      sources: string[];
    }) => void = () => {},
    private readonly renderAuthorizedPrompt?: AuthorizedMessagePromptRenderer,
  ) {}
  close(): void {
    this.#closed = true;
    this.#candidates.clear();
    this.#approvals.clear();
    this.#validatedCrossDeliveries.clear();
    this.#conversations.clear();
    this.#routing.clear();
    this.#routeCandidates.clear();
    this.#cacheExpiry.clear();
  }
  private prune(): void {
    for (const [id, expires] of this.#cacheExpiry) {
      if (expires > this.now().getTime()) continue;
      this.#conversations.delete(id);
      this.#routeCandidates.delete(id);
      this.#routing.delete(id);
      this.#cacheExpiry.delete(id);
    }
    for (const [id, value] of this.#candidates)
      if (value.expires <= this.now().getTime()) this.#candidates.delete(id);
    for (const [id, value] of this.#approvals)
      if (value.expires <= this.now().getTime()) this.#approvals.delete(id);
  }
  /** 同一冻结 turn 只查询一次目录；持久化投影可重放，私有引用重启后不恢复授权。 */
  async conversation(
    input: DeepReadonly<InformationAtom>,
  ): Promise<DeepReadonly<InformationAtom>> {
    this.prune();
    const turn = await this.read(input.informationId);
    if (turn.kind !== turnContextCompletedInformationKind.kind)
      throw new Error("invalid-source-turn");
    let pending = this.#conversations.get(turn.informationId);
    if (!pending) {
      pending = this.freezeConversation(turn);
      this.#conversations.set(turn.informationId, pending);
      this.#cacheExpiry.set(turn.informationId, this.now().getTime() + 300000);
      pending.catch(() => this.#conversations.delete(turn.informationId));
    }
    return pending;
  }
  private async freezeConversation(
    turn: DeepReadonly<InformationAtom>,
  ): Promise<DeepReadonly<InformationAtom>> {
    // 用关系读取精确 turn；不能把其他会话的背景混入当前轮。
    const frozen = await this.core.select(
      defineInformationSelector({
        selectorId: "runtime.conversation.frozen",
        select: async ({ sourceAtom, ledger }) =>
          (
            await ledger.related({
              from: [sourceAtom.informationId],
              relation: "core:uses-context",
              direction: "incoming",
              limit: 1000,
            })
          )
            .filter((a) => a.kind === conversationContextInformationKind.kind)
            .map((a) => a.informationId),
      }),
      turn.informationId,
    );
    if (frozen[0]) return frozen[0];
    const payload = turnContextCompletedInformationKind.payloadSchema.parse(
      turn.payload,
    ) as unknown as FrozenRoutingTurn;
    const inputs = payload.inputs;
    const latest = inputs.at(-1)!;
    const source = latest.source;
    const texts = inputs.map((i) => i.text).join("\n");
    type Projection = z.infer<
      typeof conversationContextInformationKind.payloadSchema
    >;
    const background: Projection["background"] = {
      scope: source.destination.kind,
      name: source.destination.kind === "group" ? "当前群聊" : "当前会话",
      participants: [],
    };
    const accounts = new Map<string, string>();
    for (const input of inputs) {
      const key = input.source.senderId;
      if (accounts.has(key)) continue;
      const label = `person-${accounts.size + 1}`;
      accounts.set(key, label);
      background.participants.push({
        label,
        name: (
          input.source.sender?.card ??
          input.source.sender?.nickname ??
          "未命名参与者"
        ).slice(0, 100),
        identityStatus: input.identity.status,
        relation: key === source.senderId ? "speaker" : "participant",
      });
    }
    const resolution: Projection["resolution"] = {
      status: "unavailable",
      targets: [],
    };
    const routes = new Map<string, Candidate>();
    if (!this.#closed && this.directory && this.#routeCandidates.size < 1000) {
      try {
        const snapshot = await this.directory.listTargets();
        const unique = [
          ...new Map(
            snapshot.candidates
              .filter(
                (c) =>
                  c.adapterId === source.adapterId &&
                  c.platform === source.platform &&
                  c.destination.kind !== "web",
              )
              .map((c) => [targetKey(c), c]),
          ).values(),
        ];
        resolution.status = "available";
        const names = new Map<string, number>();
        for (const c of unique) {
          const key = JSON.stringify([c.destination.kind, c.name]);
          names.set(key, (names.get(key) ?? 0) + 1);
        }
        const mentioned = new Set(
          inputs.flatMap((i) =>
            (i.source.mentions ?? [])
              .filter((m) => m.kind === "user")
              .map((m) => (m.kind === "user" ? m.id : "")),
          ),
        );
        for (const c of unique) {
          if (c.destination.kind === "web") continue;
          const current = targetKey(c) === targetKey(source);
          const speaker =
            c.destination.kind === "private" &&
            c.destination.userId === source.senderId;
          const byMention =
            c.destination.kind === "private" &&
            mentioned.has(c.destination.userId);
          if (
            !current &&
            !speaker &&
            !byMention &&
            !(c.name.length > 0 && texts.includes(c.name))
          )
            continue;
          if (resolution.targets.length >= 100) {
            resolution.status = "unavailable";
            resolution.targets = [];
            routes.clear();
            break;
          }
          if (current) background.name = c.name.slice(0, 100);
          const name = c.name.slice(0, 100);
          if (
            byMention &&
            c.destination.kind === "private" &&
            !accounts.has(c.destination.userId)
          ) {
            background.participants.push({
              label: `mention-${background.participants.length + 1}`,
              name,
              identityStatus: "directory-matched",
              relation: "mentioned",
            });
          }
          const status = !this.allowlist.allowsDestination(
            c.platform,
            c.destination,
          )
            ? "unauthorized"
            : speaker && latest.identity.status !== "complete"
              ? "unrecognized"
              : !current &&
                  !speaker &&
                  !byMention &&
                  names.get(JSON.stringify([c.destination.kind, c.name]))! > 1
                ? "ambiguous"
                : "resolved";
          const reference = randomUUID();
          resolution.targets.push({
            kind: c.destination.kind,
            name,
            relation: current ? "current" : speaker ? "speaker" : "mentioned",
            status,
            reference: status === "resolved" ? reference : null,
          });
          if (status === "resolved")
            routes.set(reference, {
              target: c,
              generation: snapshot.generation,
              expires: this.now().getTime() + 300000,
            });
        }
      } catch {
        resolution.status = "unavailable";
        resolution.targets = [];
        routes.clear();
      }
    }
    const atom = await this.core.registerOnce(
      "runtime.conversation.v1",
      turn.informationId,
      conversationContextInformationKind,
      {
        source: "runtime:message-target",
        occurredAt: this.now().toISOString(),
        payload: { background, resolution },
        references: [
          { relation: "core:context", informationId: contextId(turn) },
          { relation: "core:uses-context", informationId: turn.informationId },
        ],
      },
    );
    this.#routeCandidates.set(turn.informationId, routes);
    return atom;
  }
  /** 只接受账本内获胜决策；原 claim 统一去重和结束来源 turn，无需管理端确认。 */
  async route(
    input: DeepReadonly<InformationAtom>,
    decisionInput: DeepReadonly<InformationAtom>,
  ): Promise<{ status: "accepted" | "failed"; reason?: string }> {
    this.prune();
    let pending = this.#routing.get(decisionInput.informationId);
    if (!pending) {
      pending = this.routeInternal(input, decisionInput);
      this.#routing.set(decisionInput.informationId, pending);
      this.#cacheExpiry.set(
        decisionInput.informationId,
        this.now().getTime() + 300000,
      );
      pending.catch(() => this.#routing.delete(decisionInput.informationId));
    }
    return pending;
  }
  private async routeInternal(
    input: DeepReadonly<InformationAtom>,
    decisionInput: DeepReadonly<InformationAtom>,
  ): Promise<{ status: "accepted" | "failed"; reason?: string }> {
    const fail = (reason: string) => ({ status: "failed" as const, reason });
    const turn = await this.read(input.informationId);
    const decision = await this.read(decisionInput.informationId);
    const payload = turnContextCompletedInformationKind.payloadSchema.parse(
      turn.payload,
    ) as unknown as FrozenRoutingTurn;
    if (
      decision.kind !== "agent.turn.plan.completed" ||
      !decision.references.some(
        (r) =>
          r.relation === "core:status-of" &&
          r.informationId === payload.claimInformationId,
      )
    )
      return fail("target-invalid-decision");
    const action = plannerActionSchema.parse(decision.payload.action);
    if (
      action.action !== "message" ||
      !action.target ||
      action.target.kind === "current"
    )
      return fail("target-invalid-decision");
    if (action.target.kind === "unresolved")
      return fail(`target-${action.target.reason}`);
    const candidate = this.#routeCandidates
      .get(turn.informationId)
      ?.get(action.target.reference);
    if (!candidate || candidate.target.destination.kind !== action.target.kind)
      return fail("target-not-found");
    if (!(await this.valid(candidate))) return fail("target-unavailable");
    if (this.#approvals.size >= 1000) return fail("target-unavailable");
    const target = {
      adapterId: candidate.target.adapterId,
      platform: candidate.target.platform,
      destination: candidate.target.destination,
    };
    const provenance = {
      candidateInformationId: payload.candidateInformationId,
      claimInformationId: payload.claimInformationId,
      contextInformationId: turn.informationId,
    };
    const authorization = await this.core.registerOnce(
      "runtime.planner.authorization.v1",
      decision.informationId,
      targetAuthorizedInformationKind,
      {
        source: "runtime:message-target",
        occurredAt: this.now().toISOString(),
        payload: {
          target,
          turn: provenance,
          instruction: action.target.instruction,
          expiresAt: new Date(candidate.expires).toISOString(),
        },
        references: [
          { relation: "core:context", informationId: contextId(turn) },
          { relation: "core:uses-context", informationId: turn.informationId },
        ],
      },
    );
    const conversation = await this.conversation(turn);
    const approval: Approval = this.#approvals.get(
      authorization.informationId,
    ) ?? {
      ...candidate,
      authorizationId: authorization.informationId,
      candidateId: payload.candidateInformationId,
      confirmed: true,
      automatic: true,
      conversationId: conversation.informationId,
    };
    this.#approvals.set(authorization.informationId, approval);
    const intent = await this.core.registerOnce(
      "agent.heartflow.message-intent",
      payload.claimInformationId,
      messageIntentRequestedInformationKind,
      {
        source: "runtime:message-target",
        occurredAt: this.now().toISOString(),
        payload: {
          target,
          turn: provenance,
          memoryInformationIds: [],
          composition: resolveComposition(payload, action.composition),
        },
        references: [
          { relation: "core:context", informationId: contextId(turn) },
          { relation: "core:caused-by", informationId: decision.informationId },
          {
            relation: "agent:target-authorization",
            informationId: authorization.informationId,
          },
          {
            relation: "core:uses-context",
            informationId: authorization.informationId,
          },
          {
            relation: "agent:turn-claim",
            informationId: payload.claimInformationId,
          },
          {
            relation: "agent:turn-candidate",
            informationId: payload.candidateInformationId,
          },
        ],
      },
    );
    approval.intentId = intent.informationId;
    return { status: "accepted" };
  }
  async sources() {
    if (this.#closed) return [];
    const turns = await this.core.find({
      kinds: ["agent.turn.context.completed"],
      order: "desc",
      limit: 50,
    });
    return turns.map((turn) => ({
      informationId: turn.informationId,
      occurredAt: turn.occurredAt,
      target: (() => {
        const source = turn.payload.source as unknown as MessageTarget;
        return {
          adapterId: source.adapterId,
          platform: source.platform,
          destination: source.destination,
        };
      })(),
    }));
  }
  async resolve(query: TargetQuery): Promise<TargetResolution> {
    const result = await this.resolveInternal(query);
    this.audit({
      status: result.status,
      mode: query.mode,
      sources:
        "candidates" in result
          ? [...new Set(result.candidates.map((c) => c.target.adapterId))]
          : [],
    });
    return result;
  }
  private async resolveInternal(query: TargetQuery): Promise<TargetResolution> {
    query = targetQuerySchema.parse(query);
    this.prune();
    if (this.#closed || !this.directory) return { status: "unavailable" };
    let snapshot;
    try {
      snapshot = await this.directory.listTargets();
    } catch {
      return { status: "unavailable" };
    }
    if (this.#closed) return { status: "unavailable" };
    const unique = new Map<string, ReachableTarget>();
    for (const candidate of snapshot.candidates) {
      if (candidate.destination.kind === "web") continue;
      if (
        (query.adapterId && candidate.adapterId !== query.adapterId) ||
        (query.kind && candidate.destination.kind !== query.kind)
      )
        continue;
      const id =
        candidate.destination.kind === "group"
          ? candidate.destination.groupId
          : candidate.destination.userId;
      const matches =
        query.mode === "id"
          ? id === query.value
          : query.mode === "name"
            ? candidate.name === query.value
            : query.value
                .toLocaleLowerCase()
                .includes(candidate.name.toLocaleLowerCase()) &&
              candidate.name.length > 0;
      if (matches) unique.set(targetKey(candidate), candidate);
    }
    if (!unique.size) return { status: "not-found" };
    const visible = [...unique.values()].filter((c) =>
      this.allowlist.allowsDestination(c.platform, c.destination),
    );
    if (!visible.length) return { status: "unauthorized" };
    if (visible.length > 100 || this.#candidates.size + visible.length > 1000)
      return { status: "unavailable" };
    const candidates = visible.map((target) => {
      const reference = randomUUID();
      this.#candidates.set(reference, {
        target,
        generation: snapshot.generation,
        expires: this.now().getTime() + 300000,
      });
      return {
        reference,
        name: target.name,
        target: {
          adapterId: target.adapterId,
          platform: target.platform,
          destination: target.destination,
        },
      };
    });
    // 描述匹配永远只是建议；即便只有一项仍要求管理端明确选定。
    return {
      status:
        unique.size === 1 && query.mode !== "description"
          ? "resolved"
          : "ambiguous",
      candidates,
    };
  }
  private async valid(candidate: Candidate): Promise<boolean> {
    if (
      this.#closed ||
      candidate.expires <= this.now().getTime() ||
      !this.directory ||
      !this.allowlist.allowsDestination(
        candidate.target.platform,
        candidate.target.destination,
      )
    )
      return false;
    try {
      if (
        "candidateId" in candidate &&
        (
          await this.core.find({
            kinds: ["agent.turn.failed"],
            payloadContains: {
              candidateInformationId: String(candidate.candidateId),
            },
            limit: 1,
          })
        ).length > 0
      )
        return false;
      const snapshot = await this.directory.listTargets();
      return (
        !this.#closed &&
        candidate.expires > this.now().getTime() &&
        snapshot.generation === candidate.generation &&
        snapshot.candidates.some(
          (c) => targetKey(c) === targetKey(candidate.target),
        )
      );
    } catch {
      return false;
    }
  }
  async authorize(input: {
    reference: string;
    sourceTurnContextInformationId: string;
    instruction: string;
  }) {
    const parsed = z
      .object({
        reference: z.string().min(1),
        sourceTurnContextInformationId: z.string().min(1),
        instruction: z.string().trim().min(1).max(16000),
      })
      .strict()
      .parse(input);
    const candidate = this.#candidates.get(parsed.reference);
    // 单次消费先于异步查询，防止并发确认产生两个 intent。
    this.#candidates.delete(parsed.reference);
    if (!candidate || !(await this.valid(candidate)))
      return { status: "expired" as const };
    if (this.#approvals.size >= 1000) return { status: "unavailable" as const };
    const turn = await this.read(parsed.sourceTurnContextInformationId);
    if (turn.kind !== "agent.turn.context.completed")
      throw new Error("invalid-source-turn");
    const sourceTurn = turnContextCompletedInformationKind.payloadSchema.parse(
      turn.payload,
    ) as unknown as FrozenRoutingTurn;
    const provenance = {
      candidateInformationId: String(turn.payload.candidateInformationId),
      claimInformationId: String(turn.payload.claimInformationId),
      contextInformationId: turn.informationId,
    };
    const target = {
      adapterId: candidate.target.adapterId,
      platform: candidate.target.platform,
      destination: candidate.target.destination,
    };
    const root = contextId(turn);
    const authorization = await this.core.register(
      targetAuthorizedInformationKind,
      {
        occurredAt: this.now().toISOString(),
        source: "runtime:message-target",
        payload: {
          target,
          turn: provenance,
          instruction: parsed.instruction,
          expiresAt: new Date(candidate.expires).toISOString(),
        },
        references: [
          { relation: "core:context", informationId: root },
          { relation: "core:uses-context", informationId: turn.informationId },
        ],
      },
    );
    // 独立 candidate/claim 防止复用已关闭来源 turn 的终态槽；原观察触发仅保留溯源。
    const originalCandidate = await this.read(
      provenance.candidateInformationId,
    );
    const candidatePayload = turnCandidateInformationKind.payloadSchema.parse(
      originalCandidate.payload,
    );
    const scopeKey = `message-target:${authorization.informationId}`;
    const isolatedCandidate = await this.core.register(
      turnCandidateInformationKind,
      {
        occurredAt: this.now().toISOString(),
        source: "runtime:message-target",
        payload: {
          ...candidatePayload,
          ...target,
          scopeKey,
          managementAuthorizationId: authorization.informationId,
        },
        references: originalCandidate.references.map((r) =>
          r.relation === "core:caused-by"
            ? { ...r, informationId: authorization.informationId }
            : r,
        ),
      },
    );
    const claim = await this.core.register(turnClaimedInformationKind, {
      occurredAt: this.now().toISOString(),
      source: "runtime:message-target",
      payload: {
        candidateInformationId: isolatedCandidate.informationId,
        scopeKey,
        generation: 0,
        predecessorTerminalInformationId: null,
      },
      references: [
        { relation: "core:context", informationId: root },
        {
          relation: "core:caused-by",
          informationId: isolatedCandidate.informationId,
        },
        {
          relation: "agent:turn-candidate",
          informationId: isolatedCandidate.informationId,
        },
      ],
    });
    const approvedTurn = {
      candidateInformationId: isolatedCandidate.informationId,
      claimInformationId: claim.informationId,
      contextInformationId: authorization.informationId,
    };
    const approval: Approval = {
      ...candidate,
      authorizationId: authorization.informationId,
      candidateId: isolatedCandidate.informationId,
      confirmed: false,
    };
    this.#approvals.set(authorization.informationId, approval);
    const intent = await this.core.register(
      messageIntentRequestedInformationKind,
      {
        occurredAt: this.now().toISOString(),
        source: "runtime:message-target",
        payload: {
          target,
          turn: approvedTurn,
          memoryInformationIds: [],
          composition: {
            focusInformationIds: [
              String(sourceTurn.inputs.at(-1)!.informationId),
            ],
            topic: Array.from(parsed.instruction).slice(0, 200).join(""),
            replyAct: "按批准要求发送消息",
          },
        },
        references: [
          { relation: "core:context", informationId: root },
          {
            relation: "core:caused-by",
            informationId: authorization.informationId,
          },
          {
            relation: "agent:target-authorization",
            informationId: authorization.informationId,
          },
          {
            relation: "core:uses-context",
            informationId: authorization.informationId,
          },
          { relation: "agent:turn-claim", informationId: claim.informationId },
          {
            relation: "agent:turn-candidate",
            informationId: isolatedCandidate.informationId,
          },
        ],
      },
    );
    approval.intentId = intent.informationId;
    return {
      status: "confirmation-required" as const,
      requestId: authorization.informationId,
      intentInformationId: intent.informationId,
    };
  }
  async read(id: string): Promise<DeepReadonly<InformationAtom>> {
    const atom = (await this.core.select(selfSelector, id as InformationId))[0];
    if (!atom) throw new Error("target-authorization-required");
    return atom;
  }
  private async intentFor(
    atom: DeepReadonly<InformationAtom>,
  ): Promise<DeepReadonly<InformationAtom>> {
    let current = atom;
    for (let i = 0; i < 8; i++) {
      if (current.kind === messageIntentRequestedInformationKind.kind)
        return current;
      const causes = await this.core.select(
        causeSelector,
        current.informationId,
      );
      if (causes.length !== 1) break;
      current = causes[0]!;
    }
    throw new Error("target-authorization-required");
  }
  private async approved(
    intent: DeepReadonly<InformationAtom>,
    checkFresh = true,
  ): Promise<Approval | undefined> {
    const payload = messageIntentRequestedInformationPayloadSchema.parse(
      intent.payload,
    );
    const reference = intent.references.find(
      (r) => r.relation === "agent:target-authorization",
    );
    if (reference) {
      const approval = this.#approvals.get(reference.informationId);
      if (
        !approval ||
        approval.intentId !== intent.informationId ||
        ((checkFresh || !approval.automatic) &&
          !(await this.valid(approval))) ||
        targetKey(payload.target) !== targetKey(approval.target) ||
        payload.memoryInformationIds.length
      )
        throw new Error("target-authorization-required");
      return approval;
    }
    const turn = await this.read(payload.turn.contextInformationId);
    if (
      turn.kind !== "agent.turn.context.completed" ||
      turn.payload.candidateInformationId !==
        payload.turn.candidateInformationId ||
      turn.payload.claimInformationId !== payload.turn.claimInformationId
    )
      throw new Error("target-authorization-required");
    const inputs = turn.payload.inputs;
    const latest = Array.isArray(inputs) ? inputs.at(-1) : undefined;
    if (
      !latest ||
      typeof latest !== "object" ||
      !("source" in latest) ||
      targetKey(latest.source as unknown as MessageTarget) !==
        targetKey(payload.target)
    )
      throw new Error("target-authorization-required");
    const inputAtom = await this.read(
      String((latest as { informationId: unknown }).informationId),
    );
    if (
      inputAtom.kind !== "core.message.inbound.text" ||
      inputAtom.source !== "runtime:ingress" ||
      targetKey(inputAtom.payload.source as unknown as MessageTarget) !==
        targetKey(payload.target)
    )
      throw new Error("target-authorization-required");
    return undefined;
  }
  async prepare(input: DeepReadonly<InformationAtom>) {
    const intent = await this.read(input.informationId);
    const approval = await this.approved(intent);
    if (!approval) return undefined;
    const frozen = await this.read(approval.authorizationId);
    const conversation = approval.conversationId
      ? await this.read(approval.conversationId)
      : undefined;
    if (!this.renderAuthorizedPrompt)
      throw new Error("Authorized message prompt renderer is unavailable");
    return {
      contextAtoms: [intent, frozen, ...(conversation ? [conversation] : [])],
      prompt: this.renderAuthorizedPrompt({
        automatic: approval.automatic ?? false,
        instruction: {
          name: "instruction",
          content: String(frozen.payload.instruction),
          informationIds: [frozen.informationId],
        },
        ...(conversation
          ? {
              background: {
                name: "background",
                content: JSON.stringify(conversation.payload.background),
                informationIds: [conversation.informationId],
              },
            }
          : {}),
      }),
    };
  }
  async stage(input: DeepReadonly<InformationAtom>): Promise<boolean> {
    const assistant = await this.read(input.informationId);
    const approval = await this.approved(
      await this.intentFor(assistant),
      false,
    );
    if (!approval) return true;
    const source = assistant.payload.source as unknown as MessageTarget;
    if (
      targetKey(source) !== targetKey(approval.target) ||
      typeof assistant.payload.text !== "string"
    )
      throw new Error("target-authorization-required");
    if (
      approval.assistantId &&
      approval.assistantId !== assistant.informationId
    )
      throw new Error("target-authorization-required");
    approval.assistantId = assistant.informationId;
    approval.text = assistant.payload.text;
    return approval.confirmed;
  }
  async status(requestId: string) {
    const approval = this.#approvals.get(requestId);
    if (!approval || !(await this.valid(approval)))
      return { status: "expired" as const };
    return {
      status: approval.confirmed
        ? ("confirmed" as const)
        : approval.assistantId
          ? ("confirmation-required" as const)
          : ("composing" as const),
      target: approval.target,
      ...(approval.assistantId
        ? { assistantInformationId: approval.assistantId, text: approval.text }
        : {}),
    };
  }
  async confirm(
    requestId: string,
    assistantInformationId: string,
    text: string,
  ) {
    const approval = this.#approvals.get(requestId);
    if (
      !approval ||
      approval.confirming ||
      approval.confirmed ||
      !approval.assistantId ||
      approval.assistantId !== assistantInformationId ||
      approval.text !== text
    )
      return { status: "conflict" as const };
    approval.confirming = true;
    try {
      if (!(await this.valid(approval))) return { status: "expired" as const };
      const assistant = await this.read(assistantInformationId);
      approval.confirmed = true;
      await this.core.registerOnce(
        "runtime.message.confirmation.v1",
        requestId,
        messageConfirmedInformationKind,
        {
          occurredAt: this.now().toISOString(),
          source: "runtime:message-target",
          payload: { assistantInformationId },
          references: [
            {
              relation: "core:caused-by",
              informationId: assistant.informationId,
            },
            { relation: "core:context", informationId: contextId(assistant) },
          ],
        },
      );
      return { status: "confirmed" as const };
    } finally {
      approval.confirming = false;
    }
  }
  /** 不包含 await；紧贴实际 transport 调用复核 TTL 与 adapter 连接代次。 */
  deliveryStillCurrent(requestId: InformationId): boolean {
    const approval = this.#validatedCrossDeliveries.get(requestId);
    this.#validatedCrossDeliveries.delete(requestId);
    return (
      !this.#closed &&
      (!approval ||
        (approval.expires > this.now().getTime() &&
          (this.directory?.isCurrentGeneration?.(approval.generation) ?? true)))
    );
  }
  async validateDelivery(
    request: DeepReadonly<InformationAtom>,
  ): Promise<boolean> {
    try {
      const intent = await this.intentFor(request);
      const approval = await this.approved(intent);
      const target = {
        adapterId: String(request.payload.adapterId),
        platform: String(request.payload.platform),
        destination: request.payload.destination,
      } as MessageTarget;
      if (
        targetKey(target) !==
        targetKey(
          messageIntentRequestedInformationPayloadSchema.parse(intent.payload)
            .target,
        )
      )
        return false;
      if (!approval) return true;
      const message = request.payload.message;
      if (
        !approval.confirmed ||
        !message ||
        typeof message !== "object" ||
        !("kind" in message) ||
        message.kind !== "text" ||
        !("text" in message) ||
        message.text !== approval.text ||
        (approval.deliveryId && approval.deliveryId !== request.informationId)
      )
        return false;
      approval.deliveryId = request.informationId;
      this.#validatedCrossDeliveries.set(request.informationId, approval);
      return true;
    } catch {
      return false;
    }
  }
}

function resolveComposition(
  turn: FrozenRoutingTurn,
  composition: Extract<
    z.infer<typeof plannerActionSchema>,
    { action: "message" }
  >["composition"],
) {
  const indexes = composition.focusInputIndexes;
  if (
    indexes.length < 1 ||
    indexes.length > 3 ||
    new Set(indexes).size !== indexes.length ||
    indexes.some((index) => index < 0 || index >= turn.inputs.length)
  )
    throw new Error("target-invalid-composition");
  return {
    focusInformationIds: indexes.map(
      (index) => turn.inputs[index]!.informationId,
    ),
    topic: composition.topic,
    replyAct: composition.replyAct,
    ...("tone" in composition ? { tone: composition.tone } : {}),
    ...("guidance" in composition ? { guidance: composition.guidance } : {}),
  };
}
