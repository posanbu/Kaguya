/** Immutable Information copies and one evidence-bound readable wrapper per semantic Kind. */
import type { PlatformDestination } from "@kaguya/schema";
import { defineModuleCapability } from "@kaguya/sdk";

export interface RawScope {
  readonly platform: string;
  readonly adapterId: string;
  readonly destination: PlatformDestination;
}
export interface RawReference {
  readonly relation: string;
  readonly informationId: string;
}
export interface RawEvent {
  readonly informationId: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly position: number;
  readonly payload: Record<string, unknown>;
  readonly references: readonly RawReference[];
  readonly scope: RawScope | null;
}
export interface RawContextBlock {
  readonly text: string;
  readonly informationIds: readonly string[];
}
export interface FrozenRawContext {
  readonly global: RawContextBlock;
  readonly currentScope: RawContextBlock;
  readonly overBudget: boolean;
  readonly characterCount: number;
}
export interface RawContextAccess {
  freeze(input: {
    readonly turnInformationId: string;
    readonly asOf: string;
    readonly scope: RawScope;
    readonly unreadInformationIds: readonly string[];
  }): Promise<FrozenRawContext>;
}
export const rawContextCapability = defineModuleCapability<RawContextAccess>(
  "memory:raw-context",
  1,
);

export const RAW_SEMANTIC_KINDS = [
  "core.message.inbound.text",
  "core.delivery.delivered",
  "core.delivery.failed",
  "memory.identity.chat.scope.binding",
  "memory.identity.platform.account.binding",
  "memory.identity.person.profile.revision",
  "memory.text",
  "memory.expression.learning.completed",
  "core.person.fact.extracted",
] as const;
export type RawSemanticKind = (typeof RAW_SEMANTIC_KINDS)[number];
export const RAW_PROJECTED_KINDS = [
  ...RAW_SEMANTIC_KINDS,
  "filter.decision",
] as const;

const obj = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const ref = (event: RawEvent, relation: string) =>
  event.references.find((item) => item.relation === relation)?.informationId;
const target = (scope: RawScope) =>
  `${scope.platform}/${scope.adapterId}/${scope.destination.kind}:${scope.destination.kind === "private" ? scope.destination.userId : scope.destination.kind === "group" ? scope.destination.groupId : (scope.destination.conversationId ?? "default")}`;

interface Evidence {
  get(id: string | undefined, kind?: string): RawEvent | undefined;
  readonly ids: readonly string[];
}
type Wrapper = (
  event: RawEvent,
  evidence: Evidence,
  unread: boolean,
) => string | undefined;
function collectEvidence(
  source: ReadonlyMap<string, RawEvent>,
  event: RawEvent,
): Evidence {
  const ids = [event.informationId];
  return {
    ids,
    get(id, kind) {
      const atom = id ? source.get(id) : undefined;
      if (!atom || (kind && atom.kind !== kind)) return undefined;
      ids.push(atom.informationId);
      return atom;
    },
  };
}

function inboundText(
  event: RawEvent,
  _evidence: Evidence,
  unread: boolean,
): string | undefined {
  const source = obj(event.payload.source);
  const sender = obj(source?.sender);
  const reply = obj(source?.replyTo);
  const name =
    str(sender?.card) ?? str(sender?.nickname) ?? str(source?.senderId);
  if (!event.scope || !name || typeof event.payload.text !== "string")
    return undefined;
  const selfId = str(source?.selfId);
  const mentionedSelf =
    selfId &&
    Array.isArray(source?.mentions) &&
    source.mentions.some(
      (item) => obj(item)?.kind === "user" && obj(item)?.id === selfId,
    );
  const repliedToSelf = selfId && str(reply?.senderId) === selfId;
  return `${unread ? "【未读】" : ""}${name}（账号 ${String(source?.senderId)}）在 ${target(event.scope)} 发送：${event.payload.text}${str(source?.platformMessageId) ? `；原生消息 ID ${source!.platformMessageId}` : ""}${str(reply?.platformMessageId) ? `；原生回复消息 ${reply!.platformMessageId}` : ""}${mentionedSelf ? "；明确提及当前账号" : ""}${repliedToSelf ? "；回复当前账号" : ""}`;
}
function deliveryEvidence(
  event: RawEvent,
  evidence: Evidence,
): { text: string; target: string } | undefined {
  const request = evidence.get(
    ref(event, "core:status-of"),
    "core.delivery.requested",
  );
  const caused = evidence.get(
    ref(event, "core:caused-by"),
    "core.delivery.requested",
  );
  const message = obj(request?.payload.message);
  const destination = obj(request?.payload.destination);
  if (
    !request ||
    !caused ||
    request.informationId !== caused.informationId ||
    !str(message?.text) ||
    !destination ||
    !event.scope
  )
    return undefined;
  if (JSON.stringify(destination) !== JSON.stringify(event.scope.destination))
    return undefined;
  const source = evidence.get(ref(request, "core:caused-by"));
  if (
    !source ||
    ![
      "core.message.assistant.text",
      "agent.heavy.message.content.confirmed",
    ].includes(source.kind)
  )
    return undefined;
  return { text: String(message!.text), target: target(event.scope) };
}
function delivered(event: RawEvent, evidence: Evidence): string | undefined {
  const proof = deliveryEvidence(event, evidence);
  if (!proof || event.payload.ok !== true) return undefined;
  return `已发送。正文：${proof.text}；目标：${proof.target}；回执：${str(event.payload.platformMessageId) ?? "平台确认投递（无原生消息 ID）"}`;
}
function failed(event: RawEvent, evidence: Evidence): string | undefined {
  const proof = deliveryEvidence(event, evidence);
  if (!proof || event.payload.ok !== false || !str(event.payload.error))
    return undefined;
  return `发送失败，对方未被确认收到。尝试正文：${proof.text}；目标：${proof.target}；失败结果：${event.payload.error}`;
}
function chatScopeBinding(
  event: RawEvent,
  evidence: Evidence,
): string | undefined {
  const entity = evidence.get(
    ref(event, "core:binds"),
    "memory.identity.chat.scope.entity",
  );
  if (
    !entity ||
    !event.scope ||
    entity.payload.platform !== event.scope.platform ||
    entity.payload.adapterId !== event.scope.adapterId ||
    JSON.stringify(entity.payload.destination) !==
      JSON.stringify(event.scope.destination)
  )
    return undefined;
  return `身份归属记录：平台目标 ${target(event.scope)} 绑定到会话范围 ${entity.informationId}（${str(entity.payload.scopeMode) ?? "未标注模式"}）。`;
}
function accountBinding(
  event: RawEvent,
  evidence: Evidence,
): string | undefined {
  const account = evidence.get(
    ref(event, "core:binds"),
    "memory.identity.platform.account.entity",
  );
  const personId = str(event.payload.personInformationId);
  const person = evidence.get(personId, "memory.identity.person.entity");
  if (
    !account ||
    !person ||
    !personId ||
    !str(account.payload.accountId) ||
    !str(account.payload.platform) ||
    !str(account.payload.adapterId) ||
    (str(event.payload.accountId) !== undefined &&
      event.payload.accountId !== account.payload.accountId)
  )
    return undefined;
  return `身份归属记录：${account.payload.platform}/${account.payload.adapterId} 账号 ${account.payload.accountId} 绑定到人物实体 ${personId}；关系来自绑定记录，不由昵称推断。`;
}
function profileRevision(
  event: RawEvent,
  evidence: Evidence,
): string | undefined {
  const person = evidence.get(
    ref(event, "memory:profile-of"),
    "memory.identity.person.entity",
  );
  const sections = obj(event.payload.sections);
  if (
    !person ||
    !sections ||
    typeof event.payload.revision !== "number" ||
    (str(event.payload.personInformationId) !== undefined &&
      event.payload.personInformationId !== person.informationId)
  )
    return undefined;
  const entries = Object.entries(sections)
    .flatMap(([section, value]) =>
      Array.isArray(value)
        ? value.map((item) => `${section}：${str(obj(item)?.text) ?? ""}`)
        : [],
    )
    .filter((item) => !item.endsWith("："));
  const metadata = obj(event.payload.metadata);
  const cited = [
    ...Object.values(sections).flatMap((value) =>
      Array.isArray(value) ? value : [],
    ),
    ...(Array.isArray(metadata?.aliases) ? metadata.aliases : []),
  ].flatMap((entry) =>
    Array.isArray(obj(entry)?.evidenceInformationIds)
      ? (obj(entry)!.evidenceInformationIds as unknown[])
      : [],
  );
  if (cited.some((id) => !str(id) || !evidence.get(String(id))))
    return undefined;
  const names = [
    str(metadata?.primaryName),
    ...(Array.isArray(metadata?.aliases)
      ? metadata.aliases.map((item) => str(obj(item)?.text))
      : []),
  ].filter((name): name is string => !!name);
  return `人物实体 ${person.informationId} 的画像修订 ${event.payload.revision} 已保存；内容：${entries.join("；") || "空"}${names.length ? `；名称：${names.join("、")}` : ""}${str(metadata?.knownStatus) ? `；认识状态：${String(metadata?.knownStatus)}` : ""}${cited.length ? `；证据：${[...new Set(cited)].join("、")}` : ""}。保存记录不代表当前已生效。`;
}
function memoryText(event: RawEvent, evidence: Evidence): string | undefined {
  const sourceIds = event.references
    .filter((item) => item.relation === "core:uses-context")
    .map((item) => item.informationId);
  if (
    !str(event.payload.text) ||
    sourceIds.length === 0 ||
    sourceIds.some((id) => !evidence.get(id))
  )
    return undefined;
  return `派生记忆陈述：${event.payload.text}；来源：${sourceIds.join("、")}`;
}
function expressionLearning(
  event: RawEvent,
  evidence: Evidence,
): string | undefined {
  const habits = Array.isArray(event.payload.habits)
    ? event.payload.habits
        .map(obj)
        .filter((item): item is Record<string, unknown> => !!item)
    : [];
  const scope = evidence.get(
    str(event.payload.scopeInformationId),
    "memory.identity.chat.scope.entity",
  );
  if (event.payload.status !== "completed" || habits.length === 0 || !scope)
    return undefined;
  const sourceIds = habits.flatMap((habit) =>
    Array.isArray(habit.sourceInformationIds)
      ? habit.sourceInformationIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [],
  );
  const cited = new Set(
    event.references
      .filter((item) => item.relation === "core:uses-context")
      .map((item) => item.informationId),
  );
  if (
    sourceIds.length === 0 ||
    sourceIds.some((id) => !cited.has(id) || !evidence.get(id))
  )
    return undefined;
  return `成功学习表达习惯（范围 ${scope.informationId}）：${habits.map((habit) => `${habit.situation} → ${habit.style}`).join("；")}；证据：${[...new Set(sourceIds)].join("、")}`;
}
function personFact(event: RawEvent, evidence: Evidence): string | undefined {
  const task = evidence.get(
    ref(event, "core:caused-by"),
    "core.model.task.completed",
  );
  const request =
    task &&
    evidence.get(ref(task, "core:status-of"), "core.model.task.requested");
  const candidate =
    request &&
    evidence.get(
      str(request.payload.sourceInformationId),
      "core.person.fact.candidate",
    );
  const source = candidate && evidence.get(ref(candidate, "core:caused-by"));
  if (
    !source ||
    !candidate ||
    !str(event.payload.fact) ||
    !str(candidate.payload.text) ||
    !String(candidate.payload.text).includes(String(event.payload.fact))
  )
    return undefined;
  return `从证据 ${source.informationId} 的候选片段 ${candidate.informationId}（原文：${candidate.payload.text}）提取人物 ${str(event.payload.name) ?? str(event.payload.personId) ?? "未知"} 的原文片段：${event.payload.fact}。这是提取结果，尚非永久人物结论。`;
}

/** Adding a semantic Kind requires a dedicated function here and a contract test. */
const wrappers = {
  "core.message.inbound.text": inboundText,
  "core.delivery.delivered": delivered,
  "core.delivery.failed": failed,
  "memory.identity.chat.scope.binding": chatScopeBinding,
  "memory.identity.platform.account.binding": accountBinding,
  "memory.identity.person.profile.revision": profileRevision,
  "memory.text": memoryText,
  "memory.expression.learning.completed": expressionLearning,
  "core.person.fact.extracted": personFact,
} satisfies Record<RawSemanticKind, Wrapper>;

/** Missing required evidence makes the event ineligible. There is no generic JSON fallback. */
export function renderRawEvent(
  event: RawEvent,
  source: ReadonlyMap<string, RawEvent>,
  unread = false,
): RawContextBlock | undefined {
  const wrapper = Object.hasOwn(wrappers, event.kind)
    ? wrappers[event.kind as RawSemanticKind]
    : undefined;
  if (!wrapper) return undefined;
  const evidence = collectEvidence(source, event);
  const body = wrapper(event, evidence, unread);
  return body
    ? {
        text: `[${event.occurredAt}] ${body}`,
        informationIds: [...new Set(evidence.ids)],
      }
    : undefined;
}
