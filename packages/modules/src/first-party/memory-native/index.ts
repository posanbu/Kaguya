/** One runtime module; durable collection, formation and publication have separate boundaries. */
/** One runtime module; durable collection, formation and publication have separate boundaries. */
import { nativeMemorySnapshotSchema } from "@kaguya/schema";
import { sourceSelector, sourceParticipants } from "./collection.js";
import { stableId, publishFormation } from "./formation.js";
import {
  defineInformationModule,
  onInformation,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import {
  nativeMemorySettingsSchema,
  nativeMemoryCapability,
  memoryFormationCapability,
  memoryScope,
  type MemoryBatch,
} from "@kaguya/memory";
import {
  oneShotScheduleCapability,
  oneShotDueInformationKind,
} from "@kaguya/scheduler";
import {
  inboundTextInformationKind,
  personContextCompletedInformationKind,
} from "../information-kinds.js";
import { learned as qqMeaning } from "../qq-expression/facts.js";
import { firstPartyInspection } from "../inspection.js";
import {
  nativeMemoryRequested,
  nativeMemoryCompleted,
  nativeMemoryRevision,
  nativeMemoryRetry,
  formationOutputSchema,
} from "./facts.js";
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import { nativeMemoryTemplateDeclaration } from "../../prompt-declarations.js";
import type { CreateRouterModuleOptions } from "../router/index.js";
import { deliveryRequestedInformationKind } from "../kinds/message.js";
import type { CreateHeavyModuleOptions } from "../heavy/index.js";

export function createNativeMemoryModule(
  options: Pick<CreateHeavyModuleOptions, "modelTaskCapability"> & {
    nativeMemoryTemplate: string;
    deliveryDeliveredInformationKind?: CreateRouterModuleOptions["deliveryDeliveredInformationKind"];
  },
) {
  const render = createPromptTemplateRenderer({
    kind: "memory",
    templateId: "memory.native.form.v1",
    main: {
      ...nativeMemoryTemplateDeclaration,
      content: options.nativeMemoryTemplate,
    },
  });
  async function request(
    batch: MemoryBatch,
    context: InformationModuleHandlerContext,
    contextInformationId?: string,
  ) {
    const owners = [
      ...new Set([
        ...batch.sources.map((s) => s.ownerId),
        ...batch.sources.flatMap((s) =>
          s.participants.flatMap((p) => (p.ownerId ? [p.ownerId] : [])),
        ),
        `conversation:${batch.scope}`,
        "self:kaguya",
        "expression:kaguya",
      ]),
    ];
    const existing = await context.use(nativeMemoryCapability).prepare({
      scope: batch.scope,
      owners,
      asOf: context.now().toISOString(),
      query: batch.sources
        .map((s) => s.text)
        .join("\n")
        .slice(-512),
    });
    return context.registerOnce(
      "memory.native.batch",
      batch.id,
      nativeMemoryRequested,
      {
        ...(contextInformationId ? { contextInformationId } : {}),
        payload: {
          batchId: batch.id,
          scope: batch.scope,
          sources: batch.sources.map((s) => ({ ...s })),
          existing,
        },
        references: batch.sources.map((s) => ({
          relation: "core:uses-context",
          informationId: s.id,
        })),
      },
    );
  }
  return defineInformationModule({
    manifest: {
      category: "memory",
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      definitionId: "memory.native",
      tags: ["memory"],
      inspection: firstPartyInspection["memory.native"],
      displayName: "统一记忆",
      summary: "统一形成、整理、检索和冻结分层记忆。",
      description:
        "人物关系、会话属性、经历及表达共用记忆图。level 0 在适用范围内固定注入，其他内容按图与混合检索召回。",
      settingsSchema: nativeMemorySettingsSchema,
      consumes: [
        personContextCompletedInformationKind,
        oneShotDueInformationKind,
        nativeMemoryRequested,
        nativeMemoryRevision,
        nativeMemoryRetry,
        qqMeaning,
        ...(options.deliveryDeliveredInformationKind
          ? [options.deliveryDeliveredInformationKind]
          : []),
      ],
      produces: [
        nativeMemoryRequested,
        nativeMemoryCompleted,
        nativeMemoryRevision,
        nativeMemoryRetry,
      ],
      selectors: [sourceSelector],
      promptRenderers: [],
      promptTemplates: [nativeMemoryTemplateDeclaration],
      requires: [
        nativeMemoryCapability,
        memoryFormationCapability,
        options.modelTaskCapability,
        oneShotScheduleCapability,
      ],
      provides: [],
    },
    create: ({ activation }) => ({
      provisions: [],
      start(context) {
        const run = () => {
          void context.use(nativeMemoryCapability).index(context.signal);
        };
        run();
        const timer = setInterval(run, 60_000);
        timer.unref();
        context.signal.addEventListener("abort", () => clearInterval(timer), {
          once: true,
        });
      },
      subscriptions: [
        onInformation(
          nativeMemoryRetry,
          { subscriptionId: "memory.native.retry", delivery: "durable" },
          async (atom, context) => {
            const batch = await context
              .use(memoryFormationCapability)
              .claim(atom.payload.scope, true);
            if (batch) await request(batch, context);
          },
        ),
        ...(options.deliveryDeliveredInformationKind
          ? [
              onInformation(
                options.deliveryDeliveredInformationKind,
                {
                  subscriptionId: "memory.native.delivered",
                  delivery: "durable",
                },
                async (atom, context) => {
                  if (atom.payload.ok !== true) return;
                  const source = (await context.select(sourceSelector)).find(
                    (a) => a.kind === deliveryRequestedInformationKind.kind,
                  );
                  if (!source) return;
                  const p =
                    deliveryRequestedInformationKind.payloadSchema.parse(
                      source.payload,
                    );
                  if (!("text" in p.message) || !p.message.text.trim()) return;
                  const scope = memoryScope(p);
                  const formation = context.use(memoryFormationCapability);
                  if (
                    !(await formation.ingest({
                      id: atom.informationId,
                      scope,
                      ownerId: "self:kaguya",
                      sourceType: "delivered",
                      participants: [],
                      replyTo: null,
                      text: `自身已经发出的消息（不代表已完成其中承诺的行动）：${p.message.text}`,
                      occurredAt: atom.occurredAt,
                      collectedAt: context.now().toISOString(),
                    }))
                  )
                    return;
                  await context.use(oneShotScheduleCapability).schedule({
                    operationKey: `memory.native.flush:${atom.informationId}`,
                    sourceInformationId: atom.informationId,
                    dueAt: new Date(
                      context.now().getTime() + 60_000,
                    ).toISOString(),
                    input: { scope, consumer: "memory.native" },
                    activation,
                  });
                  const batch = await formation.claim(
                    scope,
                    false,
                    context.now().toISOString(),
                  );
                  if (batch) await request(batch, context);
                },
              ),
            ]
          : []),
        onInformation(
          qqMeaning,
          { subscriptionId: "memory.native.qq-meaning", delivery: "durable" },
          async (atom, context) => {
            const p = qqMeaning.payloadSchema.parse(atom.payload);
            const sources = await context.select(sourceSelector);
            const source = sources.find(
              (a) => a.kind === inboundTextInformationKind.kind,
            );
            if (!source || !p.evidenceIds.length) return;
            const raw = inboundTextInformationKind.payloadSchema.parse(
              source.payload,
            );
            const scope = memoryScope(raw.source);
            const id = stableId("qq-asset", p.assetInformationId);
            const access = context.use(nativeMemoryCapability);
            if (await access.published(`qq-meaning:${atom.informationId}`))
              return;
            const snapshot = await access.prepare({
              scope,
              owners: ["expression:kaguya"],
              query: "",
              asOf: context.now().toISOString(),
            });
            const previous =
              snapshot.fixed.find((node) => node.id === id) ??
              snapshot.recalled.find((r) => r.node.id === id)?.node;
            if (previous?.metadata.locked) return;
            await access.publish({
              operationId: `qq-meaning:${atom.informationId}`,
              actor: "automatic",
              nodes: [
                {
                  expectedRevision: previous?.metadata.revision ?? 0,
                  node: {
                    id,
                    content: `文字上下文推断：${p.meaning || "含义未知"}。用法：${p.usage || "未知"}`,
                    metadata: {
                      system: "native-v1",
                      kind: "expression",
                      ownerId: "expression:kaguya",
                      scope,
                      level: 1,
                      revision: (previous?.metadata.revision ?? 0) + 1,
                      status: "active",
                      locked: false,
                      sourceIds: p.evidenceIds,
                      aliases: [],
                      tags: ["QQ表情"],
                      occurredAt: atom.occurredAt,
                      qqAssetId: p.assetInformationId,
                      expressionType: "qq-resource",
                      confidence: p.confidence,
                      basis: "context-inference",
                    },
                  },
                },
              ],
            });
          },
        ),
        onInformation(
          nativeMemoryRevision,
          { subscriptionId: "memory.native.index", delivery: "durable" },
          async (_atom, context) => {
            await context.use(nativeMemoryCapability).index(context.signal);
          },
        ),
        onInformation(
          personContextCompletedInformationKind,
          { subscriptionId: "memory.native.collect", delivery: "durable" },
          async (atom, context) => {
            const p = atom.payload;
            if (
              !["complete", "unresolved"].includes(String(p.status)) ||
              p.scopeMode !== "canonical"
            )
              return;
            const source = (await context.select(sourceSelector)).find(
              (a) => a.kind === inboundTextInformationKind.kind,
            );
            if (
              !source ||
              typeof source.payload.text !== "string" ||
              !source.payload.text.trim()
            )
              return;
            const parsed = inboundTextInformationKind.payloadSchema.parse(
              source.payload,
            );
            if (
              parsed.source.sender?.isSelf ||
              (parsed.source.senderId !== undefined &&
                parsed.source.senderId === parsed.source.selfId)
            )
              return;
            const scope = memoryScope(parsed.source);
            const formation = context.use(memoryFormationCapability);
            const accepted = await formation.ingest({
              id: source.informationId,
              scope,
              ownerId: p.personInformationId
                ? `person:${p.personInformationId}`
                : `conversation:${scope}`,
              sourceType: "inbound",
              participants: await sourceParticipants(
                parsed.source,
                p.personInformationId
                  ? `person:${p.personInformationId}`
                  : null,
                context.use(nativeMemoryCapability),
              ),
              replyTo: parsed.source.replyTo
                ? {
                    platformMessageId: parsed.source.replyTo.platformMessageId,
                    senderId: parsed.source.replyTo.senderId ?? null,
                  }
                : null,
              text: parsed.text,
              occurredAt: source.occurredAt,
              collectedAt: context.now().toISOString(),
            });
            if (!accepted) return;
            await context.use(oneShotScheduleCapability).schedule({
              operationKey: `memory.native.flush:${source.informationId}`,
              sourceInformationId: atom.informationId,
              dueAt: new Date(context.now().getTime() + 60_000).toISOString(),
              input: { scope, consumer: "memory.native" },
              activation,
            });
            const batch = await formation.claim(
              scope,
              false,
              context.now().toISOString(),
            );
            if (batch) await request(batch, context);
          },
        ),
        onInformation(
          oneShotDueInformationKind,
          { subscriptionId: "memory.native.flush", delivery: "durable" },
          async (atom, context) => {
            const selected = await context.select(sourceSelector);
            const schedule = selected.find(
              (a) => a.kind === "core.schedule.one-shot.requested",
            );
            const input = schedule?.payload.input as
              { scope?: string; consumer?: string } | undefined;
            if (input?.consumer !== "memory.native" || !input.scope) return;
            const runtime = selected.find(
              (a) => a.kind === "core.runtime.context",
            );
            if (!runtime) throw new Error("memory_flush_context_missing");
            const batch = await context
              .use(memoryFormationCapability)
              .claim(input.scope, true, context.now().toISOString());
            if (batch) await request(batch, context, runtime.informationId);
            await context.use(oneShotScheduleCapability).finish({
              scheduleInformationId: atom.payload.scheduleInformationId,
              status: "fired",
            });
          },
        ),
        onInformation(
          nativeMemoryRequested,
          {
            // Memory uses one permanent v1 event kind and stable subscription identity.
            subscriptionId: "memory.native.form",
            delivery: "durable",
            retryForever: true,
            retryDelayMs: 5000,
          },
          async (atom, context) => {
            const payload = nativeMemoryRequested.payloadSchema.parse(
              atom.payload,
            );
            const p = {
              ...payload,
              existing: nativeMemorySnapshotSchema.parse(payload.existing),
            };
            const sources = await context.select(sourceSelector);
            const result = await context
              .use(options.modelTaskCapability)
              .execute({
                task: {
                  taskId: "memory.native.form",
                  outputMode: "object",
                  outputSchema: formationOutputSchema,
                  allowedTiers: ["light"],
                },
                sourceInformationId: atom.informationId,
                contextInformationId: atom.references.find(
                  (r) => r.relation === "core:context",
                )!.informationId,
                activation,
                selectionPolicy: { tier: "light" },
                contextAtoms: [atom, ...sources],
                prompt: render([
                  {
                    name: "context",
                    content: JSON.stringify(p),
                    informationIds: [
                      atom.informationId,
                      ...sources.map((s) => s.informationId),
                    ],
                  },
                ]),
              });
            const { status, reason, nodeIds } = await publishFormation(
              p,
              result,
              atom.occurredAt,
              context.use(nativeMemoryCapability),
            );
            await context.commitTerminal(
              "memory.native.formation",
              atom.informationId,
              nativeMemoryCompleted,
              {
                payload: {
                  batchId: p.batchId,
                  scope: p.scope,
                  status,
                  nodeIds,
                  reason,
                },
                references: [
                  {
                    relation: "core:status-of",
                    informationId: atom.informationId,
                  },
                ],
              },
            );
            await context
              .use(memoryFormationCapability)
              .finish(p.batchId, status);
            const next = await context
              .use(memoryFormationCapability)
              .claim(p.scope, false, context.now().toISOString());
            if (next) await request(next, context);
          },
        ),
      ],
    }),
  });
}
