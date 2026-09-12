/**
 * 功能概述：将消息意图和冻结 turn 编译为分层 Handlebars Prompt，所有本轮输入拥有相同模板地位。
 * 主要职责：createMessagePromptCompiler 预编译模板并返回纯函数；compileMessagePrompt 提供一次性入口；
 * frozenTurnInputs 核对 turn 身份与目标范围，重建冻结消息；历史与记忆预算函数只限制辅助上下文。
 * 代码库关系：message-context 选择账本事实，Node 模板加载器提供 MessagePromptTemplates；编译结果携带变量溯源。
 * 输入输出与副作用：意图没有正文，正文从 turn.inputs 读取；每条输入保留引用上下文及成功回执、请求、assistant 的原始溯源且不裁剪，不特殊处理末条。
 * 缺少冻结 turn 或身份不一致即抛错；不写账本、不调用模型、不创建出站引用标记。
 */
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
  messageIntentRequestedInformationKind,
  messageIntentRequestedInformationPayloadSchema,
  turnContextCompletedInformationKind,
} from "../information-kinds.js";

import {
  beforeQuoteCutoff,
  resolveMessageQuote,
  sameMessageTarget,
} from "./message-quote.js";

export interface AgentIdentity {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly persona: string;
}

export interface MessagePromptTemplates {
  readonly main: string;
  readonly history: string;
  readonly historyInbound: string;
  readonly historyAssistant: string;
  readonly memory: string;
  readonly memoryItem: string;
  readonly quoted: string;
  readonly turn: string;
}

export const ZH_CN_MESSAGE_PROMPT = Object.freeze({
  version: "zh-CN/v3",
  groupRule:
    "已决定在当前群聊中发送一条自然消息。结合本轮全部输入、不同群友之间的互动和聊天记录，围绕一个清晰话题简短表达。不要替其他群友发言，不要刻意找话题或反复介绍自己；表情包只需理解其含义，不必逐个解释。",
  privateRule:
    "已决定在当前私聊中发送一条自然消息。结合本轮全部输入、对方的表达和聊天记录，围绕一个清晰话题简短表达，保持自然的对话语气。",
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
  "quoted_message",
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
  "turn",
] as const;

export function createMessagePromptCompiler(
  templates: MessagePromptTemplates,
  identity: AgentIdentity,
): (
  atoms: readonly DeepReadonly<InformationAtom>[],
  sourceInformationId: InformationId,
) => CompiledPrompt {
  assertAgentIdentity(identity);
  const nested = compileNested(templates);
  const renderOuter = createPromptTemplateRenderer({
    kind: "message",
    templateId: `kaguya.message.${ZH_CN_MESSAGE_PROMPT.version}`,
    main: template("message-composer", templates.main, outerVariables),
  });
  const outerTemplates = renderOuter(emptyVariables(outerVariables)).templates;
  const allTemplates = [...outerTemplates, ...nested.templates].map(
    (entry) => ({
      ...entry,
    }),
  );

  return (atoms, sourceInformationId) => {
    const message = atoms.find(
      ({ informationId }) => informationId === sourceInformationId,
    );
    if (message?.kind !== messageIntentRequestedInformationKind.kind)
      throw new Error("Message selection must include the current input");
    const payload = messageIntentRequestedInformationPayloadSchema.parse(
      message.payload,
    );
    const inputs = frozenTurnInputs(atoms, payload);
    const selfIds = [
      ...new Set(
        inputs
          .map(
            (input) => (messagePayload(input).source as MessageSource).selfId,
          )
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    if (selfIds.length > 1)
      throw new Error("Frozen turn self accounts are inconsistent");
    const asOf = String(
      atoms.find(
        (atom) => atom.informationId === payload.turn.contextInformationId,
      )!.payload.asOf,
    );
    const inputIds = new Set(inputs.map(({ informationId }) => informationId));
    const memoryInformationIds = new Set(payload.memoryInformationIds);
    const historyAtoms = atoms.filter(
      (atom) =>
        sameMessageTarget(atom.payload.source, payload.target) &&
        beforeQuoteCutoff(atom, asOf) &&
        !inputIds.has(atom.informationId) &&
        !memoryInformationIds.has(atom.informationId) &&
        (atom.kind === inboundTextInformationKind.kind ||
          atom.kind === assistantTextInformationKind.kind),
    );
    const history = renderHistory(nested, historyAtoms, identity);
    const memories = renderMemories(
      nested,
      payload.memoryInformationIds.map((id) => {
        const atom = atoms.find((atom) => atom.informationId === id);
        if (!atom) throw new Error(`Missing selected memory: ${id}`);
        return atom;
      }),
      identity,
    );
    const quoteIds: InformationId[] = [];
    const messages = inputs.map((input) => {
      const quotedId = platformMessageIdOfQuote(input);
      const quote =
        quotedId === undefined
          ? undefined
          : resolveMessageQuote(
              [
                ...atoms.filter((atom) => !inputIds.has(atom.informationId)),
                ...inputs,
              ],
              quotedId,
              payload.target,
              asOf,
            );
      const quotedAtom = quote?.message;
      if (quote)
        quoteIds.push(...quote.provenance.map((atom) => atom.informationId));
      return {
        ...messageContext(input, identity),
        quoted_message: quotedAtom
          ? nested.render("quoted", {
              message: renderMessage(nested, quotedAtom, identity),
              message_id: quotedId,
            })
          : "",
      };
    });
    const turn = nested.render("turn", { messages });
    const prompt = renderOuter([
      variable("persona", identity.persona),
      variable("name", identity.name),
      variable("aliases", identity.aliases.join("、")),
      variable(
        "self_account",
        selfIds[0] ?? "",
        inputs.map((input) => input.informationId),
      ),
      variable(
        "scene",
        payload.target.destination.kind === "group"
          ? ZH_CN_MESSAGE_PROMPT.groupRule
          : ZH_CN_MESSAGE_PROMPT.privateRule,
        [message.informationId],
      ),
      variable("history", history.content, history.informationIds),
      variable("memory", memories.content, memories.informationIds),
      variable("turn", turn, [
        ...new Set([
          ...inputs.map((input) => input.informationId),
          ...quoteIds,
        ]),
      ]),
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

export function compileMessagePrompt(
  templates: MessagePromptTemplates,
  identity: AgentIdentity,
  atoms: readonly DeepReadonly<InformationAtom>[],
  sourceInformationId: InformationId,
): CompiledPrompt {
  return createMessagePromptCompiler(templates, identity)(
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
    if (kept.length === ZH_CN_MESSAGE_PROMPT.historyMessageLimit) break;
    if (characters >= ZH_CN_MESSAGE_PROMPT.historyCharacterLimit) break;
    const cost = Array.from(messagePayload(atom).text).length;
    kept.push(atom);
    characters += Math.min(
      cost,
      ZH_CN_MESSAGE_PROMPT.historyCharacterLimit - characters,
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
    if (characters >= ZH_CN_MESSAGE_PROMPT.memoryCharacterLimit) break;
    kept.push(atom);
    characters += Math.min(
      Array.from(memoryText(atom)).length,
      ZH_CN_MESSAGE_PROMPT.memoryCharacterLimit - characters,
    );
  }
  return kept;
}

function compileNested(templates: MessagePromptTemplates) {
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
    template(
      "turn",
      templates.turn,
      ["messages", ...messageVariables],
      ["history-inbound"],
    ),
  ]);
}

function renderHistory(
  renderer: CompiledPromptTemplateSet,
  atoms: readonly DeepReadonly<InformationAtom>[],
  identity: AgentIdentity,
): { content: string; informationIds: InformationId[] } {
  let remaining = ZH_CN_MESSAGE_PROMPT.historyCharacterLimit;
  const contexts = new Map<InformationId, Record<string, unknown>>();
  for (const atom of [...atoms]
    .sort(compareAtoms)
    .reverse()
    .slice(0, ZH_CN_MESSAGE_PROMPT.historyMessageLimit)) {
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
  let remaining = ZH_CN_MESSAGE_PROMPT.memoryCharacterLimit;
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
  const source = payload.source as MessageSource;
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
    quoted_message: "",
    content: payload.text,
    self_account: source.selfId ?? "",
    name: identity.name,
  };
}

function messagePayload(atom: DeepReadonly<InformationAtom>) {
  if (atom.kind === inboundTextInformationKind.kind)
    return inboundTextInformationKind.payloadSchema.parse(atom.payload);
  if (atom.kind === assistantTextInformationKind.kind)
    return assistantTextInformationKind.payloadSchema.parse(atom.payload);
  throw new Error(`Unsupported message information kind: ${atom.kind}`);
}

function memoryText(atom: DeepReadonly<InformationAtom>): string {
  if (atom.kind === coreMemoryTextInformationKind.kind)
    return coreMemoryTextInformationKind.payloadSchema.parse(atom.payload).text;
  return messagePayload(atom).text;
}

type MessageSource = ReturnType<
  typeof inboundTextInformationKind.payloadSchema.parse
>["source"];

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

/** 将冻结输入恢复为消息视图，不读取 turn.text/source 的旧版末条摘要。 */
export function frozenTurnInputs(
  atoms: readonly DeepReadonly<InformationAtom>[],
  intent: ReturnType<
    typeof messageIntentRequestedInformationPayloadSchema.parse
  >,
): readonly DeepReadonly<InformationAtom>[] {
  const turn = atoms.find(
    (atom) => atom.informationId === intent.turn.contextInformationId,
  );
  if (turn?.kind !== turnContextCompletedInformationKind.kind)
    throw new Error("Message selection must include the frozen turn context");
  const payload = turnContextCompletedInformationKind.payloadSchema.parse(
    turn.payload,
  ) as {
    candidateInformationId: string;
    claimInformationId: string;
    inputs: {
      informationId: string;
      occurredAt: string;
      text: string;
      source: MessageSource;
    }[];
  };
  if (
    payload.candidateInformationId !== intent.turn.candidateInformationId ||
    payload.claimInformationId !== intent.turn.claimInformationId
  )
    throw new Error("Frozen turn provenance does not match message intent");
  const seen = new Set<string>();
  return payload.inputs.map(
    (input: {
      informationId: string;
      occurredAt: string;
      text: string;
      source: MessageSource;
    }) => {
      if (seen.has(input.informationId))
        throw new Error("Duplicate frozen turn input");
      seen.add(input.informationId);
      const source = input.source;
      if (
        source.adapterId !== intent.target.adapterId ||
        source.platform !== intent.target.platform ||
        JSON.stringify(source.destination) !==
          JSON.stringify(intent.target.destination)
      )
        throw new Error(
          "Frozen turn input target does not match message intent",
        );
      return {
        informationId: input.informationId as InformationId,
        kind: inboundTextInformationKind.kind,
        occurredAt: input.occurredAt,
        source: turn.source,
        payload: inboundTextInformationKind.payloadSchema.parse({
          text: input.text,
          source,
        }),
        references: [],
      };
    },
  );
}

function platformMessageIdOfQuote(
  atom: DeepReadonly<InformationAtom>,
): string | undefined {
  return (messagePayload(atom).source as MessageSource).replyTo
    ?.platformMessageId;
}
