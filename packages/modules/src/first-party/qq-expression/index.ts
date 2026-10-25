import { nativeMemoryCapability } from "@kaguya/memory";
/**
 * QQ 素材维护模块，默认关闭；收藏与有来源的语义学习独立持久化。
 * 不订阅草稿或选择请求，不创建 prepared，不参与回复和发送授权。
 * 旧事实仅保留在 consumes 中支持历史读取；Light 仅用于语义学习。
 */
import { createHash } from "node:crypto";
import {
  z,
  qqExpressionSchema,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  onInformation,
} from "@kaguya/sdk";
import { inboundTextInformationKind } from "../information-kinds.js";
import {
  messageDraftInformationKind,
  messagePreparedInformationKind,
} from "../kinds/message.js";
import type { CreateHeavyModuleOptions } from "../heavy/index.js";
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import { qqExpressionTemplateDeclarations } from "../../prompt-declarations.js";
import {
  collected,
  observed,
  learned,
  meaningSchema,
  selectionRequested,
  legacySelectionRequested,
  settingsSchema,
} from "./facts.js";
import { stripEmoji, scopeKey } from "./policy.js";
import { cacheQqSticker } from "./asset.js";
type Atom = DeepReadonly<InformationAtom>;
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
export function createQqExpressionModule(
  options: Pick<CreateHeavyModuleOptions, "modelTaskCapability"> & {
    templates: { learn: string };
    cacheSticker?: (url: string) => Promise<string | undefined>;
  },
) {
  const render = (key: "learn", atoms: readonly Atom[], data: unknown) =>
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
      summary: "仅收藏同会话素材并学习语义，不选择或发送表情。",
      description:
        "独立收藏与语义推断，不使用多模态，不改变是否发言和消息发送权限。",
      settingsSchema,
      consumes: [
        inboundTextInformationKind,
        observed,
        messageDraftInformationKind,
        selectionRequested,
        legacySelectionRequested,
        messagePreparedInformationKind,
      ],
      produces: [collected, observed, learned],
      selectors: [collectionSelector, sourceSelector],
      promptRenderers: [],
      promptTemplates: qqExpressionTemplateDeclarations.map((d) => ({
        ...d,
        mutability: "editable" as const,
      })),
      requires: [options.modelTaskCapability, nativeMemoryCapability],
      provides: [],
      inspection: {
        mechanism: [
          "只从同会话文字推断语义，未知素材不发送。",
          "不处理草稿，不追加表情；选择归属 Heavy。",
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
      // 仅串行化本插件的收藏提交；其它模块不受该队列影响。
      let collectionQueue = Promise.resolve();
      return {
        provisions: [],
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
              if (!context.use(nativeMemoryCapability).enabled) return;
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
        ],
      };
    },
  });
}
