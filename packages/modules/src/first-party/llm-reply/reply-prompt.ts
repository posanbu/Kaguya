/** 分层 Handlebars Reply Prompt：消息、集合和最终布局均由模板决定。 */
import type {
  CompiledPrompt,
  DeepReadonly,
  InformationAtom,
  InformationId,
  PromptVariable,
} from "@kaguya/schema";

import {
  compilePromptTemplateSet,
  createPromptTemplateRenderer,
  type CompiledPromptTemplateSet,
  type RestrictedPromptTemplate,
} from "../../prompt-template.js";
import {
  assistantTextInformationKind,
  coreMemoryTextInformationKind,
  inboundTextInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
} from "../information-kinds.js";

export interface AgentIdentity {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly persona: string;
}

export interface ReplyPromptTemplates {
  readonly main: string;
  readonly history: string;
  readonly historyInbound: string;
  readonly historyAssistant: string;
  readonly memory: string;
  readonly memoryItem: string;
  readonly quoted: string;
  readonly target: string;
}

export const ZH_CN_REPLY_PROMPT = Object.freeze({
  version: "zh-CN/v2",
  groupRule:
    "你正在群聊中（QQ 群）。回复尽量简短，一次优先回应一个话题，同时考虑不同群友发言之间的互动，避免啰嗦或把多个话题混在一起。不要每条消息都回复，优先回复主动提及你或你确实感兴趣的内容，也可以适当回应其他话题。不要替其他群友发言，不要刻意找话题或反复介绍自己；表情包只需理解其含义，不必逐个回应。",
  privateRule:
    "你正在私聊中。回复尽量简短，先把握当前聊天内容，再考虑对方的发言频率和意图，判断现在是否适合回复以及应该回复什么。",
  historyMessageLimit: 30,
  historyCharacterLimit: 12_000,
  memoryCharacterLimit: 4_000,
} as const);

const messageVariables = [
  "is_assistant",
  "occurred_at",
  "sender_name",
  "sender_id",
  "platform",
  "adapter_id",
  "destination",
  "message_id",
  "mentions",
  "reply_to",
  "content",
  "self_account",
  "name",
] as const;
const outerVariables = [
  "persona",
  "name",
  "aliases",
  "self_account",
  "scene",
  "history",
  "memory",
  "quoted",
  "target",
] as const;

export function createReplyPromptCompiler(
  templates: ReplyPromptTemplates,
  identity: AgentIdentity,
): (
  atoms: readonly DeepReadonly<InformationAtom>[],
  sourceInformationId: InformationId,
) => CompiledPrompt {
  assertAgentIdentity(identity);
  const nested = compileNested(templates);
  const renderOuter = createPromptTemplateRenderer({
    kind: "reply",
    templateId: `kaguya.reply.${ZH_CN_REPLY_PROMPT.version}`,
    main: template("llm-reply", templates.main, outerVariables),
  });
  const outerTemplates = renderOuter(emptyVariables(outerVariables)).templates;
  const allTemplates = [...outerTemplates, ...nested.templates].map(
    (entry) => ({
      ...entry,
    }),
  );

  return (atoms, sourceInformationId) => {
    const reply = atoms.find(
      ({ informationId }) => informationId === sourceInformationId,
    );
    if (reply?.kind !== replyRequestedInformationKind.kind)
      throw new Error("Reply selection must include the current input");
    const payload = replyRequestedInformationPayloadSchema.parse(reply.payload);
    const memoryInformationIds = new Set(payload.memoryInformationIds ?? []);
    const quotedId = payload.source.replyTo?.platformMessageId;
    const historyAtoms = atoms.filter(
      (atom) =>
        atom.informationId !== sourceInformationId &&
        !memoryInformationIds.has(atom.informationId) &&
        platformMessageId(atom) !== quotedId &&
        (atom.kind === inboundTextInformationKind.kind ||
          atom.kind === assistantTextInformationKind.kind),
    );
    const history = renderHistory(nested, historyAtoms, identity);
    const memories = renderMemories(
      nested,
      atoms.filter(
        (atom) =>
          atom.informationId !== sourceInformationId &&
          (atom.kind === coreMemoryTextInformationKind.kind ||
            memoryInformationIds.has(atom.informationId)),
      ),
      identity,
    );
    const quotedAtom =
      quotedId === undefined
        ? undefined
        : atoms.find((atom) => platformMessageId(atom) === quotedId);
    const quotedMessage = quotedAtom
      ? renderMessage(nested, quotedAtom, identity)
      : "";
    const quoted = nested.render("quoted", {
      message: quotedMessage,
      message_id: quotedId ?? "",
    });
    const target = nested.render("target", {
      ...messageContext(reply, identity),
      quoted_message: quotedMessage,
    });
    const prompt = renderOuter([
      variable("persona", identity.persona),
      variable("name", identity.name),
      variable("aliases", identity.aliases.join("、")),
      variable("self_account", payload.source.selfId ?? "", [
        reply.informationId,
      ]),
      variable(
        "scene",
        payload.source.destination.kind === "group"
          ? ZH_CN_REPLY_PROMPT.groupRule
          : ZH_CN_REPLY_PROMPT.privateRule,
        [reply.informationId],
      ),
      variable("history", history.content, history.informationIds),
      variable("memory", memories.content, memories.informationIds),
      variable("quoted", quoted, quotedAtom ? [quotedAtom.informationId] : []),
      variable("target", target, [reply.informationId]),
    ]);
    return { ...prompt, templates: allTemplates };
  };
}

function assertAgentIdentity(identity: AgentIdentity): void {
  const name = identity.name.trim();
  if (
    name.length === 0 ||
    identity.persona.trim().length === 0 ||
    identity.aliases.length === 0
  )
    throw new Error("Agent identity is incomplete");
  const aliases = identity.aliases.map((alias) => alias.trim());
  if (
    aliases.some((alias) => alias.length === 0 || alias === name) ||
    new Set(aliases).size !== aliases.length
  )
    throw new Error("Agent identity aliases are invalid");
}

export function compileReplyPrompt(
  templates: ReplyPromptTemplates,
  identity: AgentIdentity,
  atoms: readonly DeepReadonly<InformationAtom>[],
  sourceInformationId: InformationId,
): CompiledPrompt {
  return createReplyPromptCompiler(templates, identity)(
    atoms,
    sourceInformationId,
  );
}

export function renderHistoryAtom(
  atom: DeepReadonly<InformationAtom>,
  identity: AgentIdentity,
): string {
  const context = messageContext(atom, identity);
  return `[${String(context.occurred_at)}] ${String(context.sender_name)}：${String(context.content)}`;
}

export function fitHistoryBudget(
  atoms: readonly DeepReadonly<InformationAtom>[],
): readonly DeepReadonly<InformationAtom>[] {
  const newestFirst = [...atoms].sort(compareAtoms).reverse();
  const kept: DeepReadonly<InformationAtom>[] = [];
  let characters = 0;
  for (const atom of newestFirst) {
    if (kept.length === ZH_CN_REPLY_PROMPT.historyMessageLimit) break;
    if (characters >= ZH_CN_REPLY_PROMPT.historyCharacterLimit) break;
    const cost = Array.from(messagePayload(atom).text).length;
    kept.push(atom);
    characters += Math.min(
      cost,
      ZH_CN_REPLY_PROMPT.historyCharacterLimit - characters,
    );
  }
  return kept.sort(compareAtoms);
}

export function fitMemoryBudget(
  atoms: readonly DeepReadonly<InformationAtom>[],
): readonly DeepReadonly<InformationAtom>[] {
  const kept: DeepReadonly<InformationAtom>[] = [];
  let characters = 0;
  for (const atom of atoms) {
    if (characters >= ZH_CN_REPLY_PROMPT.memoryCharacterLimit) break;
    kept.push(atom);
    characters += Math.min(
      Array.from(memoryText(atom)).length,
      ZH_CN_REPLY_PROMPT.memoryCharacterLimit - characters,
    );
  }
  return kept;
}

function compileNested(templates: ReplyPromptTemplates) {
  return compilePromptTemplateSet([
    template(
      "history",
      templates.history,
      ["messages", ...messageVariables],
      ["history-inbound", "history-assistant"],
    ),
    template("history-inbound", templates.historyInbound, messageVariables),
    template("history-assistant", templates.historyAssistant, messageVariables),
    template("memory", templates.memory, ["items", "content"], ["memory-item"]),
    template("memory-item", templates.memoryItem, ["content"]),
    template("quoted", templates.quoted, ["message", "message_id"]),
    template("target", templates.target, [
      ...messageVariables,
      "quoted_message",
    ]),
  ]);
}

function renderHistory(
  renderer: CompiledPromptTemplateSet,
  atoms: readonly DeepReadonly<InformationAtom>[],
  identity: AgentIdentity,
): { content: string; informationIds: InformationId[] } {
  let remaining = ZH_CN_REPLY_PROMPT.historyCharacterLimit;
  const contexts = new Map<InformationId, Record<string, unknown>>();
  for (const atom of [...atoms]
    .sort(compareAtoms)
    .reverse()
    .slice(0, ZH_CN_REPLY_PROMPT.historyMessageLimit)) {
    if (remaining <= 0) break;
    const context = messageContext(atom, identity);
    const name = context.is_assistant ? "history-assistant" : "history-inbound";
    const bounded = boundRenderedContext(renderer, name, context, remaining);
    const cost = Array.from(renderer.render(name, bounded)).length;
    if (cost > remaining) continue;
    remaining -= cost;
    contexts.set(atom.informationId, bounded);
  }
  const ordered = [...atoms]
    .sort(compareAtoms)
    .filter((atom) => contexts.has(atom.informationId));
  return {
    content: renderer.render("history", {
      messages: ordered.map((atom) => contexts.get(atom.informationId)!),
    }),
    informationIds: ordered.map(({ informationId }) => informationId),
  };
}

function renderMemories(
  renderer: CompiledPromptTemplateSet,
  atoms: readonly DeepReadonly<InformationAtom>[],
  identity: AgentIdentity,
): { content: string; informationIds: InformationId[] } {
  let remaining = ZH_CN_REPLY_PROMPT.memoryCharacterLimit;
  const items: { content: string }[] = [];
  const informationIds: InformationId[] = [];
  for (const atom of atoms) {
    if (remaining <= 0) break;
    const raw =
      atom.kind === coreMemoryTextInformationKind.kind
        ? memoryText(atom)
        : renderMessage(renderer, atom, identity);
    const context = boundRenderedContext(
      renderer,
      "memory-item",
      { content: raw },
      remaining,
    );
    const cost = Array.from(renderer.render("memory-item", context)).length;
    if (cost > remaining) continue;
    remaining -= cost;
    items.push({ content: String(context.content ?? "") });
    informationIds.push(atom.informationId);
  }
  return {
    content: renderer.render("memory", { items }),
    informationIds,
  };
}

function boundRenderedContext(
  renderer: CompiledPromptTemplateSet,
  name: string,
  context: Record<string, unknown>,
  maximum: number,
): Record<string, unknown> {
  const content = String(context.content ?? "");
  if (Array.from(renderer.render(name, context)).length <= maximum)
    return context;
  const points = Array.from(content);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...context, content: points.slice(0, middle).join("") };
    if (Array.from(renderer.render(name, candidate)).length <= maximum)
      low = middle;
    else high = middle - 1;
  }
  if (low === 0) return { ...context, content: "" };
  return {
    ...context,
    content: `${points.slice(0, Math.max(0, low - 1)).join("")}…`,
  };
}

function renderMessage(
  renderer: CompiledPromptTemplateSet,
  atom: DeepReadonly<InformationAtom>,
  identity: AgentIdentity,
): string {
  const context = messageContext(atom, identity);
  return renderer.render(
    context.is_assistant ? "history-assistant" : "history-inbound",
    context,
  );
}

function messageContext(
  atom: DeepReadonly<InformationAtom>,
  identity: AgentIdentity,
): Record<string, unknown> {
  const payload = messagePayload(atom);
  const source = payload.source;
  return {
    is_assistant: atom.kind === assistantTextInformationKind.kind,
    occurred_at: atom.occurredAt,
    sender_name:
      atom.kind === assistantTextInformationKind.kind
        ? identity.name
        : displayName(source),
    sender_id:
      atom.kind === assistantTextInformationKind.kind
        ? (source.selfId ?? "")
        : source.senderId,
    platform: source.platform,
    adapter_id: source.adapterId,
    destination: destinationLabel(source.destination),
    message_id: source.platformMessageId,
    mentions: (source.mentions ?? [])
      .map((mention: { kind: "all" } | { kind: "user"; id: string }) =>
        mention.kind === "all" ? "@全体成员" : `@${mention.id}`,
      )
      .join("、"),
    reply_to: source.replyTo?.platformMessageId ?? "",
    content: payload.text,
    self_account: source.selfId ?? "",
    name: identity.name,
  };
}

function messagePayload(atom: DeepReadonly<InformationAtom>) {
  if (
    atom.kind === inboundTextInformationKind.kind ||
    atom.kind === replyRequestedInformationKind.kind
  )
    return replyRequestedInformationPayloadSchema.parse(atom.payload);
  if (atom.kind === assistantTextInformationKind.kind)
    return assistantTextInformationKind.payloadSchema.parse(atom.payload);
  throw new Error(`Unsupported message information kind: ${atom.kind}`);
}

function memoryText(atom: DeepReadonly<InformationAtom>): string {
  if (atom.kind === coreMemoryTextInformationKind.kind)
    return coreMemoryTextInformationKind.payloadSchema.parse(atom.payload).text;
  return messagePayload(atom).text;
}

type MessageSource = ReturnType<typeof messagePayload>["source"];

function destinationLabel(destination: MessageSource["destination"]): string {
  return destination.kind === "group"
    ? `群聊 ${destination.groupId}`
    : destination.kind === "private"
      ? `私聊 ${destination.userId}`
      : "网页会话";
}

function displayName(source: MessageSource): string {
  return source.sender?.card ?? source.sender?.nickname ?? source.senderId;
}

function platformMessageId(
  atom: DeepReadonly<InformationAtom>,
): string | undefined {
  if (
    atom.kind !== inboundTextInformationKind.kind &&
    atom.kind !== assistantTextInformationKind.kind
  )
    return undefined;
  return messagePayload(atom).source.platformMessageId;
}

function compareAtoms(
  left: DeepReadonly<InformationAtom>,
  right: DeepReadonly<InformationAtom>,
): number {
  return (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
    left.informationId.localeCompare(right.informationId)
  );
}

function template(
  name: string,
  content: string,
  allowedVariables: readonly string[],
  allowedPartials: readonly string[] = [],
): RestrictedPromptTemplate {
  return { name, content, allowedVariables, allowedPartials };
}

function variable(
  name: string,
  content: string,
  informationIds: readonly InformationId[] = [],
): PromptVariable {
  return { name, content, informationIds: [...informationIds] };
}

function emptyVariables(names: readonly string[]): PromptVariable[] {
  return names.map((name) => variable(name, ""));
}
