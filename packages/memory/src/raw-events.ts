/** Immutable Information copies and one evidence-bound readable wrapper per semantic Kind. */
/** Immutable Information copies and one evidence-bound readable wrapper per semantic Kind. */
import type { EvidenceRecord, PlatformDestination } from "@kaguya/schema";
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
  readonly through?: number;
  readonly evidence?: readonly EvidenceRecord[];
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
/** Adding a semantic Kind requires a dedicated function here and a contract test. */
const wrappers = {
  "core.message.inbound.text": inboundText,
  "core.delivery.delivered": delivered,
  "core.delivery.failed": failed,
  "memory.identity.chat.scope.binding": chatScopeBinding,
  "memory.identity.platform.account.binding": accountBinding,
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
