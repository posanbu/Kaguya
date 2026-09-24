/**
 * 功能概述：独立 QQ 表情插件，从真人上下文推断收藏表情的用法，并对草稿进行低频装饰。
 * collectionSelector 隔离群/适配器并限量选择上下文；收藏素材与学习结果独立持久化。
 * draftSelector 仅允许当前会话及 Planner 明确幽默/调侃意图，候选和来源先冻结再调用模型。
 * finalSelector 恢复原草稿、冻结来源及近期输出；串行额度提交防止并发草稿连发表情。
 * 所有模型失败、未知语义、跨群请求和额度不足均退回原正文；不主动发言、不改变投递授权。
 * Composer 只在显式启用插件时产生草稿，插件保存 prepared 后仍由 Composer 登记 assistant 并沿原链路发送。
 */
import { createHash } from "node:crypto";
import {
  z,
  qqExpressionSchema,
  type DeepReadonly,
  type InformationAtom,
  type OutboundExpression,
} from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  onInformation,
  type InformationSelectorLedger,
} from "@kaguya/sdk";
import {
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  turnContextCompletedInformationKind,
} from "../information-kinds.js";
import {
  messageDraftInformationKind,
  messagePreparedInformationKind,
  messageDraftProcessorReady,
} from "../kinds/message.js";
import type { CreateMessageComposerModuleOptions } from "../message-composer/index.js";
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import { qqExpressionTemplateDeclarations } from "../../prompt-declarations.js";
import {
  collected,
  observed,
  learned,
  meaningSchema,
  selectionRequested,
  selectionSchema,
  settingsSchema,
} from "./facts.js";
import { emojiParts, stripEmoji, scopeKey, rateAllowed } from "./policy.js";
import { cacheQqSticker } from "./asset.js";
type Atom = DeepReadonly<InformationAtom>;
const get = async (ledger: InformationSelectorLedger, id: string) =>
  (await ledger.find({ informationIds: [id], limit: 1 }))[0];
const collectionSelector = defineInformationSelector({
  selectorId: "plugin.qq-expression.collection",
  select: async ({ sourceAtom, ledger }) => {
    const source = inboundTextInformationKind.payloadSchema.parse(
      sourceAtom.payload,
    ).source;
    if (
      source.platform !== "qq" ||
      !source.expressions?.length ||
      source.sender?.isSelf ||
      source.senderId === source.selfId
    )
      return [];
    const scope = scopeKey(source);
    const previous = await ledger.find({
      kinds: [collected.kind],
      payloadContains: { scope },
      limit: 201,
    });
    const observations = await ledger.find({
      kinds: [observed.kind],
      payloadContains: { scope },
      registrationOrder: true,
      order: "desc",
      limit: 201,
    });
    const messages = await ledger.find({
      kinds: [inboundTextInformationKind.kind],
      payloadContains: {
        source: {
          platform: source.platform,
          adapterId: source.adapterId,
          destination: source.destination,
        },
      },
      registrationOrder: true,
      order: "desc",
      limit: 9,
    });
    return [
      ...new Set(
        [
          ...previous,
          ...observations,
          ...messages.filter(
            (a) =>
              Date.parse(a.occurredAt) <= Date.parse(sourceAtom.occurredAt),
          ),
          sourceAtom,
        ].map((a) => a.informationId),
      ),
    ];
  },
});
const sourceSelector = defineInformationSelector({
  selectorId: "plugin.qq-expression.sources",
  select: async ({ sourceAtom, ledger }) =>
    (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:uses-context",
        direction: "outgoing",
        limit: 100,
      })
    ).map((a) => a.informationId),
});
const draftSelector = defineInformationSelector({
  selectorId: "plugin.qq-expression.draft",
  select: async ({ sourceAtom, ledger }) => {
    const draft = messageDraftInformationKind.payloadSchema.parse(
      sourceAtom.payload,
    );
    if (!draft.turn) return [sourceAtom.informationId];
    // 通过模型完成的真实因果链定位 intent，不能拿同回合的另一个目标意图。
    let current: Atom | undefined = sourceAtom;
    for (
      let i = 0;
      i < 4 && current?.kind !== messageIntentRequestedInformationKind.kind;
      i++
    ) {
      const cause: string | undefined = current?.references.find(
        (r) => r.relation === "core:caused-by",
      )?.informationId;
      current = cause ? await get(ledger, cause) : undefined;
    }
    const ids = [sourceAtom.informationId];
    if (!current || current.kind !== messageIntentRequestedInformationKind.kind)
      return ids;
    ids.push(current.informationId);
    const intent = messageIntentRequestedInformationKind.payloadSchema.parse(
      current.payload,
    );
    const turn = await get(ledger, intent.turn.contextInformationId);
    if (
      !turn ||
      turn.kind !== turnContextCompletedInformationKind.kind ||
      scopeKey(draft.source) !== scopeKey(intent.target)
    )
      return ids;
    const turnSource = turn.payload.source as unknown as typeof intent.target;
    // 跨会话的确认正文不加装饰，不把本群收藏转发到其他群。
    if (
      scopeKey(turnSource) !== scopeKey(intent.target) ||
      !["humorous", "teasing"].includes(
        "tone" in intent.composition ? intent.composition.tone : "neutral",
      )
    )
      return ids;
    const inputId = (
      turn.payload.inputs as unknown as { informationId: string }[]
    ).at(-1)?.informationId;
    const input = inputId ? await get(ledger, inputId) : undefined;
    if (
      !input ||
      input.kind !== inboundTextInformationKind.kind ||
      scopeKey(
        inboundTextInformationKind.payloadSchema.parse(input.payload).source,
      ) !== scopeKey(intent.target)
    )
      return ids;
    ids.push(turn.informationId, input.informationId);
    const allMeanings = await ledger.find({
      kinds: [learned.kind],
      payloadContains: { scope: scopeKey(draft.source) },
      registrationOrder: true,
      order: "desc",
      limit: 200,
    });
    const meanings = [
      ...new Map(
        [...allMeanings]
          .reverse()
          .map((a) => [String(a.payload.assetInformationId), a]),
      ).values(),
    ];
    for (const meaning of meanings) {
      const asset = await get(
        ledger,
        String(meaning.payload.assetInformationId),
      );
      if (
        asset?.kind === collected.kind &&
        asset.payload.scope === scopeKey(draft.source)
      )
        ids.push(meaning.informationId, asset.informationId);
    }
    return ids;
  },
});
const finalSelector = defineInformationSelector({
  selectorId: "plugin.qq-expression.final",
  select: async ({ sourceAtom, ledger }) => {
    const p = selectionRequested.payloadSchema.parse(sourceAtom.payload);
    const frozen = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:uses-context",
      direction: "outgoing",
      limit: 500,
    });
    const draft = frozen.find((a) => a.informationId === p.draftInformationId);
    if (!draft) throw new Error("Missing expression draft");
    const source = messageDraftInformationKind.payloadSchema.parse(
      draft.payload,
    ).source;
    const history = await ledger.find({
      kinds: [messagePreparedInformationKind.kind],
      payloadContains: {
        source: {
          platform: source.platform,
          adapterId: source.adapterId,
          destination: source.destination,
        },
      },
      registrationOrder: true,
      order: "desc",
      limit: 101,
    });
    return [...frozen, ...history].map((a) => a.informationId);
  },
});
export function createQqExpressionModule(
  options: Pick<CreateMessageComposerModuleOptions, "modelTaskCapability"> & {
    templates: { learn: string; select: string };
    cacheSticker?: (url: string) => Promise<string | undefined>;
  },
) {
  const render = (
    key: "learn" | "select",
    atoms: readonly Atom[],
    data: unknown,
  ) =>
    createPromptTemplateRenderer({
      kind: "state",
      templateId: `plugin.qq-expression.${key}.v1`,
      main: {
        ...qqExpressionTemplateDeclarations.find((d) => d.key === key)!,
        content: options.templates[key],
      },
    })([
      {
        name: "context",
        content: JSON.stringify(data),
        informationIds: atoms.map((a) => a.informationId),
      },
    ]);
  return defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      definitionId: "plugin.qq-expression",
      displayName: "QQ 表情与 Emoji",
      tags: ["expression"],
      summary: "通过文字上下文收藏表情，并在幽默语境下低频使用。",
      description:
        "独立收藏与语义推断，不使用多模态，不改变是否发言和消息发送权限。",
      settingsSchema,
      consumes: [
        inboundTextInformationKind,
        observed,
        messageDraftInformationKind,
        selectionRequested,
      ],
      produces: [
        collected,
        observed,
        learned,
        selectionRequested,
        messagePreparedInformationKind,
      ],
      selectors: [
        collectionSelector,
        sourceSelector,
        draftSelector,
        finalSelector,
      ],
      promptRenderers: [],
      promptTemplates: qqExpressionTemplateDeclarations.map((d) => ({
        ...d,
        mutability: "editable" as const,
      })),
      requires: [options.modelTaskCapability],
      provides: [messageDraftProcessorReady],
      inspection: {
        mechanism: [
          "只从同会话文字推断语义，未知素材不发送。",
          "幽默/调侃门控与时间、回复间隔共同限频。",
        ],
        views: [
          {
            id: "meanings",
            title: "表情语义",
            description: "上下文推断及证据置信度。",
            kinds: [learned.kind],
            fields: [
              { path: "meaning", label: "推断含义" },
              { path: "usage", label: "用法" },
              { path: "confidence", label: "置信度" },
            ],
          },
        ],
      },
    },
    create: ({ settings, activation }) => {
      // 仅串行化本插件的收藏和额度提交；其它模块不受该队列影响。
      let collectionQueue = Promise.resolve();
      let sendQueue = Promise.resolve();
      return {
        provisions: [
          {
            capability: messageDraftProcessorReady,
            value: { ready: true as const },
          },
        ],
        subscriptions: [
          onInformation(
            inboundTextInformationKind,
            { subscriptionId: "qq-expression.collect", delivery: "durable" },
            (atom, context) => {
              const run = collectionQueue.then(async () => {
                const state = await context.select(collectionSelector);
                if (!state.length) return;
                const source = atom.payload.source;
                const scope = scopeKey(source);
                const assets = state.filter((a) => a.kind === collected.kind);
                const parsed = z
                  .array(qqExpressionSchema)
                  .safeParse(source.expressions);
                if (!parsed.success) return;
                const media = parsed.data[0];
                if (!media) return;
                const assetId = createHash("sha256")
                  .update(
                    JSON.stringify([
                      scope,
                      media.kind,
                      media.id,
                      media.kind === "mface" ? media.packageId : "",
                    ]),
                  )
                  .digest("hex");
                let asset = assets.find((a) => a.payload.assetId === assetId);
                if (!asset && assets.length >= settings.maxAssetsPerScope)
                  return;
                const previous = state.find(
                  (a) =>
                    a.kind === observed.kind &&
                    a.payload.assetInformationId === asset?.informationId,
                );
                if (
                  previous &&
                  context.now().getTime() - Date.parse(previous.occurredAt) <
                    60000
                )
                  return;
                const file =
                  !asset && media.kind === "sticker"
                    ? await (options.cacheSticker ?? cacheQqSticker)(media.url)
                    : undefined;
                if (!asset && media.kind === "sticker" && !file) return;
                const sources = [
                  ...new Map(
                    state
                      .filter((a) => a.kind === inboundTextInformationKind.kind)
                      .map((a) => [a.informationId, a]),
                  ).values(),
                ];
                asset ??= await context.registerOnce(
                  "qq-expression.asset",
                  assetId,
                  collected,
                  {
                    payload: {
                      scope,
                      assetId,
                      sourceInformationId: atom.informationId,
                      expression:
                        media.kind !== "sticker"
                          ? media
                          : { kind: "sticker" as const, file: file! },
                    },
                    references: sources.map((a) => ({
                      relation: "core:uses-context",
                      informationId: a.informationId,
                    })),
                  },
                );
                await context.registerOnce(
                  "qq-expression.observation",
                  `${asset.informationId}:${atom.informationId}`,
                  observed,
                  {
                    payload: {
                      scope,
                      assetInformationId: asset.informationId,
                      sourceInformationId: atom.informationId,
                    },
                    references: sources.map((a) => ({
                      relation: "core:uses-context",
                      informationId: a.informationId,
                    })),
                  },
                );
              });
              collectionQueue = run.catch(() => undefined);
              return run;
            },
          ),
          onInformation(
            observed,
            { subscriptionId: "qq-expression.learn", delivery: "durable" },
            async (atom, context) => {
              const state = await context.select(sourceSelector);
              const sources = state.filter(
                (a) => a.kind === inboundTextInformationKind.kind,
              );
              let meaning = {
                meaning: "",
                usage: "",
                confidence: 0,
                evidenceIds: [] as string[],
              };
              try {
                const result = await context
                  .use(options.modelTaskCapability)
                  .execute({
                    task: {
                      taskId: "plugin.qq-expression.learn",
                      version: "1",
                      outputMode: "object",
                      outputSchema: meaningSchema,
                      allowedTiers: ["light"],
                    },
                    sourceInformationId: atom.informationId,
                    contextInformationId: atom.references.find(
                      (r) => r.relation === "core:context",
                    )!.informationId,
                    activation,
                    selectionPolicy: { tier: "light" },
                    contextAtoms: [atom, ...sources],
                    prompt: render("learn", sources, {
                      expressionMessageId: atom.payload.sourceInformationId,
                      messages: sources.map((a) => ({
                        id: a.informationId,
                        text: String(a.payload.text).slice(0, 1000),
                      })),
                    }),
                  });
                const parsed =
                  result.status === "completed"
                    ? meaningSchema.safeParse(result.output)
                    : undefined;
                if (
                  parsed?.success &&
                  parsed.data.meaning.trim() &&
                  parsed.data.usage.trim() &&
                  parsed.data.evidenceIds.length &&
                  parsed.data.evidenceIds.every((id) =>
                    sources.some(
                      (a) =>
                        a.informationId === id &&
                        stripEmoji(String(a.payload.text))
                          .replace(/\[[^\]]*\]/gu, "")
                          .trim(),
                    ),
                  )
                )
                  meaning = parsed.data;
              } catch {
                /* 语义未知仍保留收藏，不能阻塞聊天。 */
              }
              await context.registerOnce(
                "qq-expression.meaning",
                atom.informationId,
                learned,
                {
                  payload: {
                    ...meaning,
                    scope: atom.payload.scope,
                    assetInformationId: atom.payload.assetInformationId,
                    basis: "context-inference" as const,
                  },
                  references: [atom, ...sources].map((a) => ({
                    relation: "core:uses-context",
                    informationId: a.informationId,
                  })),
                },
              );
            },
          ),
          onInformation(
            messageDraftInformationKind,
            { subscriptionId: "qq-expression.freeze", delivery: "durable" },
            async (atom, context) => {
              const state = await context.select(draftSelector);
              const meanings = state
                .filter(
                  (a) =>
                    a.kind === learned.kind &&
                    Number(a.payload.confidence) >= settings.minConfidence,
                )
                .slice(0, 24);
              // 限定模型来源，素材字节只在最终编码时读取。
              const candidateIds = meanings.map((a) =>
                String(a.payload.assetInformationId),
              );
              const frozen = state.filter(
                (a) =>
                  (a.kind !== learned.kind && a.kind !== collected.kind) ||
                  meanings.includes(a) ||
                  candidateIds.includes(a.informationId),
              );
              await context.registerOnce(
                "qq-expression.selection",
                atom.informationId,
                selectionRequested,
                {
                  payload: {
                    draftInformationId: atom.informationId,
                    scope: scopeKey(atom.payload.source),
                    candidateIds,
                  },
                  references: frozen.map((a) => ({
                    relation: "core:uses-context",
                    informationId: a.informationId,
                  })),
                },
              );
            },
          ),
          onInformation(
            selectionRequested,
            { subscriptionId: "qq-expression.finish", delivery: "durable" },
            (atom, context) => {
              const run = sendQueue.then(async () => {
                const state = await context.select(finalSelector);
                const draft = state.find(
                  (a) => a.informationId === atom.payload.draftInformationId,
                )!;
                const payload = messageDraftInformationKind.payloadSchema.parse(
                  draft.payload,
                );
                const history = state.filter(
                  (a) => a.kind === messagePreparedInformationKind.kind,
                );
                if (
                  history.some((a) =>
                    a.references.some(
                      (r) =>
                        r.relation === "core:caused-by" &&
                        r.informationId === atom.informationId,
                    ),
                  )
                )
                  return;
                const intent = state.find(
                  (a) => a.kind === messageIntentRequestedInformationKind.kind,
                );
                const turn = state.find(
                  (a) => a.kind === turnContextCompletedInformationKind.kind,
                );
                let expression: OutboundExpression | undefined;
                let text = stripEmoji(payload.text);
                // 纯 emoji 草稿被抑制时保留可读占位，避免空字符串使投递链报错。
                if (!text) text = "嗯。";
                const semanticSource = state.find(
                  (a) => a.kind === inboundTextInformationKind.kind,
                );
                const canDecorate =
                  !!semanticSource &&
                  !!turn &&
                  !!intent &&
                  rateAllowed(history, context.now().getTime(), settings);
                if (canDecorate) {
                  try {
                    const meanings = state.filter(
                      (a) => a.kind === learned.kind,
                    );
                    const promptAtoms = [
                      semanticSource!,
                      atom,
                      draft,
                      intent!,
                      turn!,
                      ...meanings,
                    ];
                    const result = await context
                      .use(options.modelTaskCapability)
                      .execute({
                        task: {
                          taskId: "plugin.qq-expression.select",
                          version: "1",
                          outputMode: "object",
                          outputSchema: selectionSchema,
                          allowedTiers: ["light"],
                        },
                        // 可选语义任务以真实入站为因果来源，失败不能沿 Composer 链结束回复。
                        // 冻结草稿和选择请求仍列在 contextAtoms 中，保留完整审计与重放指纹。
                        sourceInformationId: semanticSource!.informationId,
                        contextInformationId: semanticSource!.references.find(
                          (r) => r.relation === "core:context",
                        )!.informationId,
                        activation,
                        selectionPolicy: { tier: "light" },
                        contextAtoms: promptAtoms,
                        prompt: render("select", promptAtoms, {
                          text,
                          composition: intent!.payload.composition,
                          context: (
                            turn!.payload.inputs as unknown as {
                              text: string;
                            }[]
                          ).map((a) => a.text.slice(0, 1000)),
                          candidates: meanings.map((a) => ({
                            id: a.payload.assetInformationId,
                            meaning: a.payload.meaning,
                            usage: a.payload.usage,
                          })),
                        }),
                      });
                    const parsed =
                      result.status === "completed"
                        ? selectionSchema.safeParse(result.output)
                        : undefined;
                    if (parsed?.success) {
                      const choice = parsed.data;
                      if (
                        choice.assetInformationId &&
                        !choice.emoji &&
                        atom.payload.candidateIds.includes(
                          choice.assetInformationId,
                        )
                      ) {
                        const asset = state.find(
                          (a) =>
                            a.informationId === choice.assetInformationId &&
                            a.kind === collected.kind &&
                            a.payload.scope === atom.payload.scope,
                        );
                        if (asset)
                          expression = collected.payloadSchema.parse(
                            asset.payload,
                          ).expression;
                      } else if (
                        !choice.assetInformationId &&
                        choice.emoji &&
                        emojiParts(choice.emoji).length === 1 &&
                        emojiParts(choice.emoji)[0] === choice.emoji
                      )
                        text += ` ${choice.emoji}`;
                    }
                  } catch {
                    /* 选用失败仅回退正文，发送授权仍由 Composer 处理。 */
                  }
                }
                await context.registerOnce(
                  "qq-expression.assistant",
                  draft.informationId,
                  messagePreparedInformationKind,
                  {
                    payload: {
                      ...payload,
                      text,
                      ...(expression ? { expression } : {}),
                    },
                  },
                );
              });
              sendQueue = run.catch(() => undefined);
              return run;
            },
          ),
        ],
      };
    },
  });
}
