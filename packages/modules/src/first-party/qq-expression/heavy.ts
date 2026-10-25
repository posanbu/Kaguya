/**
 * Heavy 的可选 QQ 素材上下文。选择与正文共用一次模型请求，不读取 Light tone。
 * 素材、最新语义和真人证据一起冻结；模型只看到本轮引用与文字说明。
 * 结束阶段只解析原请求中的候选，并在串行提交前重新检查同会话额度。
 */
import { z, nativeMemorySnapshotSchema } from "@kaguya/schema";
import type {
  CompiledPrompt,
  DeepReadonly,
  InformationAtom,
  PromptVariable,
} from "@kaguya/schema";
import {
  defineInformationSelector,
  type InformationSelectorDefinition,
} from "@kaguya/sdk";
import {
  assistantTextInformationKind,
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  turnContextCompletedInformationKind,
} from "../information-kinds.js";
import type { HeavySettings } from "../heavy/index.js";
import { collected, learned } from "./facts.js";
import { rateAllowed, scopeKey } from "./policy.js";

type Atom = DeepReadonly<InformationAtom>;
type Intent = DeepReadonly<
  InformationAtom<
    string,
    ReturnType<typeof messageIntentRequestedInformationKind.payloadSchema.parse>
  >
>;

function sameScope(atom: Atom, scope: string) {
  const input = inboundTextInformationKind.payloadSchema.safeParse(
    atom.payload,
  );
  return (
    atom.kind === inboundTextInformationKind.kind &&
    input.success &&
    !input.data.source.sender?.isSelf &&
    input.data.source.senderId !== input.data.source.selfId &&
    scopeKey(input.data.source) === scope
  );
}

/** 可复用于表达习惯分派后的 selector；重放只加载已有请求，不重新挑选素材。 */
export function withQqExpressionContext(base: InformationSelectorDefinition) {
  return defineInformationSelector({
    selectorId: `${base.selectorId}.qq-expressions`,
    select: async (context) => {
      const ids = await base.select(context);
      const atoms = await context.ledger.find({
        informationIds: ids,
        limit: Math.max(1, ids.length),
      });
      const intentId =
        context.sourceAtom.kind === messageIntentRequestedInformationKind.kind
          ? context.sourceAtom.informationId
          : context.sourceAtom.payload.intentInformationId;
      if (
        atoms.some(
          (a) =>
            a.kind === "core.model.task.requested" &&
            a.payload.taskId === "agent.heavy.respond" &&
            a.payload.sourceInformationId === intentId,
        )
      )
        return ids;
      const intent = atoms.find(
        (a) =>
          a.kind === messageIntentRequestedInformationKind.kind &&
          a.informationId === intentId,
      );
      if (!intent) return ids;
      const payload = messageIntentRequestedInformationKind.payloadSchema.parse(
        intent.payload,
      );
      const turn = atoms.find(
        (a) =>
          a.informationId === payload.turn.contextInformationId &&
          a.kind === turnContextCompletedInformationKind.kind,
      );
      if (
        payload.target.platform !== "qq" ||
        !turn ||
        scopeKey(turn.payload.source as typeof payload.target) !==
          scopeKey(payload.target)
      )
        return ids;
      const scope = scopeKey(payload.target);
      const meanings = await context.ledger.find({
        kinds: [learned.kind],
        payloadContains: { scope },
        registrationOrder: true,
        order: "desc",
        limit: 200,
      });
      const seen = new Set<string>();
      const extra: Atom[] = [];
      for (const meaning of meanings) {
        const m = learned.payloadSchema.parse(meaning.payload);
        if (seen.has(m.assetInformationId)) continue;
        seen.add(m.assetInformationId);
        if (m.confidence < 0.7) continue;
        const sources = await context.ledger.related({
          from: [meaning.informationId],
          relation: "core:uses-context",
          direction: "outgoing",
          limit: 100,
        });
        const assets = await context.ledger.find({
          informationIds: [m.assetInformationId],
          kinds: [collected.kind],
          limit: 1,
        });
        const asset = assets[0];
        if (
          !asset ||
          asset.payload.scope !== scope ||
          !m.meaning.trim() ||
          !m.usage.trim() ||
          !m.evidenceIds.length ||
          !m.evidenceIds.every((id) =>
            sources.some((a) => a.informationId === id && sameScope(a, scope)),
          )
        )
          continue;
        const origin = await context.ledger.related({
          from: [asset.informationId],
          relation: "core:uses-context",
          direction: "outgoing",
          limit: 100,
        });
        if (
          !origin.some(
            (a) =>
              a.informationId === asset.payload.sourceInformationId &&
              sameScope(a, scope),
          )
        )
          continue;
        extra.push(meaning, asset, ...sources, ...origin);
        if (extra.filter((a) => a.kind === learned.kind).length >= 24) break;
      }
      const materialIds = new Set(
        atoms
          .filter((a) => a.kind === collected.kind || a.kind === learned.kind)
          .map((a) => a.informationId),
      );
      return [
        ...new Set([
          ...ids.filter((id) => !materialIds.has(id)),
          ...extra.map((a) => a.informationId),
        ]),
      ];
    },
  });
}

export function qqExpressionCandidates(
  atoms: readonly Atom[],
  intent: Intent,
  settings: HeavySettings,
) {
  const scope = scopeKey(intent.payload.target);
  const turn = atoms.find(
    (a) => a.informationId === intent.payload.turn.contextInformationId,
  );
  if (
    !settings.qqExpressionsEnabled ||
    intent.payload.target.platform !== "qq" ||
    !turn ||
    scopeKey(turn.payload.source as typeof intent.payload.target) !== scope
  )
    return [];
  const frame = atoms.find(
    (a) =>
      a.kind === "agent.situation.frozen" &&
      a.payload.turnInformationId === intent.payload.turn.contextInformationId,
  );
  const memory = frame
    ? nativeMemorySnapshotSchema.safeParse(
        (frame.payload.frame as Record<string, unknown>)?.memory,
      )
    : undefined;
  if (memory && (!memory.success || memory.data.status !== "enabled"))
    return [];
  const nodes = memory?.success
    ? [...memory.data.fixed, ...memory.data.recalled.map((r) => r.node)]
    : undefined;
  return atoms
    .filter((a) => a.kind === learned.kind)
    .flatMap((meaning) => {
      const m = learned.payloadSchema.parse(meaning.payload);
      const asset = atoms.find(
        (a) =>
          a.kind === collected.kind &&
          a.informationId === m.assetInformationId &&
          a.payload.scope === scope,
      );
      if (
        m.scope !== scope ||
        !asset ||
        m.confidence < settings.qqExpressionMinConfidence ||
        !m.meaning.trim() ||
        !m.usage.trim() ||
        !m.evidenceIds.length ||
        !m.evidenceIds.every(
          (id) =>
            meaning.references.some(
              (r) =>
                r.relation === "core:uses-context" && r.informationId === id,
            ) &&
            atoms.some((a) => a.informationId === id && sameScope(a, scope)),
        )
      )
        return [];
      if (
        !asset.references.some(
          (r) =>
            r.relation === "core:uses-context" &&
            r.informationId === asset.payload.sourceInformationId &&
            atoms.some(
              (a) => a.informationId === r.informationId && sameScope(a, scope),
            ),
        )
      )
        return [];
      const node = nodes?.find(
        (n) =>
          n.metadata.qqAssetId === asset.informationId &&
          Number(n.metadata.confidence) >= settings.qqExpressionMinConfidence,
      );
      if (nodes && !node) return [];
      return [
        {
          asset,
          meaning,
          description: {
            meaning: node?.content ?? m.meaning,
            usage: node ? "依据本轮统一 Memory 的冻结语义选用" : m.usage,
            confidence: m.confidence,
          },
        },
      ];
    })
    .slice(0, 24)
    .map((entry, index) => ({
      ...entry,
      reference: `qq-expression-${index + 1}`,
    }));
}

export function appendQqExpressionPrompt(
  prompt: CompiledPrompt,
  atoms: readonly Atom[],
  intent: Intent,
  settings: HeavySettings,
  render: (variables: readonly PromptVariable[]) => CompiledPrompt,
): CompiledPrompt {
  const candidates = qqExpressionCandidates(atoms, intent, settings);
  const suffix = render([
    {
      name: "qq_expressions",
      content: JSON.stringify({
        enabled:
          settings.qqExpressionsEnabled &&
          intent.payload.target.platform === "qq",
        candidates: candidates.map((c) => ({
          reference: c.reference,
          ...c.description,
        })),
      }),
      informationIds: [
        ...candidates.flatMap((c) => [
          c.asset.informationId,
          c.meaning.informationId,
        ]),
        ...atoms
          .filter(
            (a) =>
              a.kind === "agent.situation.frozen" &&
              a.payload.turnInformationId ===
                intent.payload.turn.contextInformationId,
          )
          .map((a) => a.informationId),
      ],
    },
  ]);
  return {
    ...prompt,
    text: prompt.text + suffix.text,
    templates: [...prompt.templates, ...suffix.templates],
    variables: [...prompt.variables, ...suffix.variables],
  };
}

export function resolveQqExpression(
  reference: unknown,
  frozen: readonly Atom[],
  intent: Intent,
  settings: HeavySettings,
  history: readonly Atom[],
  now: number,
  requestedInformationId?: string,
) {
  if (typeof reference !== "string" || !settings.qqExpressionsEnabled)
    return undefined;
  const request = frozen.find(
    (a) =>
      a.kind === "core.model.task.requested" &&
      a.payload.taskId === "agent.heavy.respond" &&
      (requestedInformationId
        ? a.informationId === requestedInformationId
        : a.payload.sourceInformationId === intent.informationId),
  );
  const prompt = request?.payload.prompt as unknown as
    CompiledPrompt | undefined;
  const variable = prompt?.variables.find((v) => v.name === "qq_expressions");
  if (!variable) return undefined;
  // Prompt 变量是冻结请求的一部分，引用不能随设置或后来的语义更新重新编号。
  const snapshotSchema = z.object({
    enabled: z.boolean(),
    candidates: z.array(z.object({ reference: z.string() })),
  });
  let snapshot: z.infer<typeof snapshotSchema>;
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(variable.content));
    if (!parsed.success) return undefined;
    snapshot = parsed.data;
  } catch {
    return undefined;
  }
  if (
    !snapshot.enabled ||
    !snapshot.candidates.some((c) => c.reference === reference)
  )
    return undefined;
  const ids = new Set(request!.payload.contextInformationIds as string[]);
  const candidates = qqExpressionCandidates(
    frozen.filter((a) => ids.has(a.informationId)),
    intent,
    settings,
  );
  const index = snapshot.candidates.findIndex((c) => c.reference === reference);
  const candidate = candidates.find(
    (c) =>
      c.asset.informationId === variable.informationIds[index * 2] &&
      c.meaning.informationId === variable.informationIds[index * 2 + 1],
  );
  if (
    !candidate ||
    !rateAllowed(history, now, {
      cooldownSeconds: settings.qqExpressionCooldownSeconds,
      minMessagesBetween: settings.qqExpressionMinMessagesBetween,
    })
  )
    return undefined;
  return collected.payloadSchema.parse(candidate.asset.payload).expression;
}

export const qqExpressionHistorySelector = defineInformationSelector({
  selectorId: "agent.heavy.qq-expression.history",
  select: async ({ sourceAtom, ledger }) => {
    const requests = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:caused-by",
      direction: "outgoing",
      limit: 1,
    });
    const intents = requests[0]
      ? await ledger.related({
          from: [requests[0].informationId],
          relation: "core:caused-by",
          direction: "outgoing",
          limit: 1,
        })
      : [];
    const source = intents[0];
    const root =
      source &&
      source.kind !== messageIntentRequestedInformationKind.kind &&
      typeof source.payload.intentInformationId === "string"
        ? (
            await ledger.find({
              informationIds: [source.payload.intentInformationId],
              kinds: [messageIntentRequestedInformationKind.kind],
              limit: 1,
            })
          )[0]
        : source;
    const parsed =
      messageIntentRequestedInformationKind.payloadSchema.safeParse(
        root?.payload,
      );
    if (!parsed.success || parsed.data.target.platform !== "qq") return [];
    const history = await ledger.find({
      kinds: [assistantTextInformationKind.kind, "agent.heavy.message.ready"],
      payloadContains: { source: parsed.data.target },
      registrationOrder: true,
      order: "desc",
      limit: 202,
    });
    const unique = new Map<string, Atom>();
    for (const a of history) {
      const key =
        (a.payload.speech as { completedInformationId?: string } | undefined)
          ?.completedInformationId ?? a.informationId;
      if (!unique.has(key)) unique.set(key, a);
    }
    return [...unique.values()]
      .filter(
        (a) =>
          !a.references.some(
            (r) =>
              r.relation === "core:caused-by" &&
              r.informationId === sourceAtom.informationId,
          ),
      )
      .slice(0, 101)
      .map((a) => a.informationId);
  },
});
