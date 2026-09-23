/**
 * Manifest 同时登记人工完整输入、可召回原文片段、无账号主体和 WebUI 共用范围，并公开整理规则模板。
 * 功能概述：在显式启用的事件记忆原型中，将身份终态和通用事件可靠投影为有来源的实体 Wiki。
 * 主要职责：seedIdentity 保留消息说话者及 reply-to；recordEvent 幂等保存原文和名称观察；
 * schedulePage 冻结双时间截止点与页面版本；refreshPage 用 CAS 写入有界章节并发布只读修订。
 * 代码库关系：composition 安装 bootstrap，database 实现 memoryKnowledgeCapability；
 * 原文 sparse/Mem0 各自继续运行，本模块不用 LLM 猜测被谈论者，也不把文本当执行结果。
 * 输入输出与副作用：通过可靠请求写数据库/账本；每页回填 50 条，每页展示最多 8 个事件及 8 条断言。
 * CAS 竞争重新安排脏页；重放复用来源、operationId 与修订槽位；故障由 Reliable Runner 有界重试。
 * mutation 可靠追加/撤回后启动有游标的维护任务；维护逐页恢复脏页，不被单个失败页面阻塞。
 * 维护 continuation 以父请求 Information ID 唯一登记，重试时脏页游标变化也不产生分支。
 */
import {
  memoryKnowledgeCapability,
  memoryEventInputSchema,
  MemoryWikiConflictError,
  KnowledgeEvidenceError,
  type MemoryKnowledgeAccess,
  type WikiRevisionInput,
} from "@kaguya/memory";
import { z, type DeepReadonly, type InformationAtom } from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  onInformation,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import {
  inboundTextInformationKind,
  personContextCompletedInformationKind,
} from "../information-kinds.js";
import {
  memoryEventSubmittedInformationKind,
  memoryKnowledgeBackfillInformationKind,
  memoryKnowledgeBootstrapCapability,
  memoryKnowledgeCompletedInformationKind,
  memoryKnowledgeMutationInformationKind,
  memoryKnowledgeMutationSchema,
  memoryKnowledgeMaintenanceInformationKind,
  memoryWikiRefreshInformationKind,
  memoryWikiUpdatedInformationKind,
} from "./kinds.js";
export * from "./kinds.js";
export * from "./ingestion-kinds.js";
import {
  userStatementInformationKind,
  userInputInformationKind,
  userSubjectInformationKind,
  userMemoryScopeInformationKind,
} from "./ingestion-kinds.js";
import { memoryIngestionTemplateDeclaration } from "../../prompt-declarations.js";

const GENERATOR_VERSION = "evidence-extract-v1";
const PAGE_SIZE = 50;
type WikiSection = WikiRevisionInput["sections"][number];
const sourceSelector = defineInformationSelector({
  selectorId: "kaguya.memory.knowledge.source",
  select: async ({ sourceAtom, ledger }) => {
    const related = await ledger.related({
      from: [sourceAtom.informationId],
      direction: "outgoing",
      limit: 100,
    });
    const ids = new Set(related.map((atom) => atom.informationId));
    if (sourceAtom.kind === personContextCompletedInformationKind.kind) {
      const p = personContextCompletedInformationKind.payloadSchema.parse(
        sourceAtom.payload,
      );
      const entityIds = [p.scopeInformationId, p.personInformationId].filter(
        (id): id is string => typeof id === "string",
      );
      if (entityIds.length)
        for (const atom of await ledger.find({
          informationIds: entityIds,
          limit: 2,
        }))
          ids.add(atom.informationId);
    }
    if (sourceAtom.kind === memoryWikiRefreshInformationKind.kind) {
      const p = memoryWikiRefreshInformationKind.payloadSchema.parse(
        sourceAtom.payload,
      );
      if (p.evidenceSourceInformationIds.length)
        for (const atom of await ledger.find({
          informationIds: p.evidenceSourceInformationIds,
          limit: 100,
        }))
          ids.add(atom.informationId);
    }
    return [...ids];
  },
});
const backfillSelector = defineInformationSelector({
  selectorId: "kaguya.memory.knowledge.backfill",
  select: async ({ sourceAtom, ledger }) => {
    const p = memoryKnowledgeBackfillInformationKind.payloadSchema.parse(
      sourceAtom.payload,
    );
    const page = await ledger.find({
      kinds: [
        personContextCompletedInformationKind.kind,
        memoryEventSubmittedInformationKind.kind,
      ],
      registrationOrder: true,
      order: "asc",
      limit: PAGE_SIZE,
      ...(p.afterInformationId
        ? { afterInformationId: p.afterInformationId }
        : {}),
    });
    return page.map((a) => a.informationId);
  },
});
const backfillEvidenceSelector = defineInformationSelector({
  selectorId: "kaguya.memory.knowledge.backfill-evidence",
  select: async (context) => {
    const ids = await backfillSelector.select(context);
    if (!ids.length) return [];
    const page = await context.ledger.find({
      informationIds: ids,
      limit: PAGE_SIZE,
    });
    const sources = [
      ...(await context.ledger.related({
        from: ids,
        relation: "agent:source",
        direction: "outgoing",
        limit: PAGE_SIZE,
      })),
      ...(await context.ledger.related({
        from: ids,
        relation: "core:status-of",
        direction: "outgoing",
        limit: PAGE_SIZE,
      })),
    ];
    const entityIds = [
      ...new Set(
        page.flatMap((a) =>
          a.kind === personContextCompletedInformationKind.kind
            ? [
                a.payload.scopeInformationId,
                a.payload.personInformationId,
              ].filter((id): id is string => typeof id === "string")
            : [],
        ),
      ),
    ];
    const entities = entityIds.length
      ? await context.ledger.find({ informationIds: entityIds, limit: 100 })
      : [];
    return [...new Set([...sources, ...entities].map((a) => a.informationId))];
  },
});

export const memoryKnowledgeModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "agent.memory.knowledge",
    displayName: "事件与 Wiki 记忆",
    summary: "持续保存有实体归属的事件和可追溯 Wiki 修订。",
    description:
      "显式启用后可靠回填原始经历，保留人物与场景的 Information 身份、断言视角及来源；页面是有界派生概览，支持原文旁路。",
    inspection: {
      mechanism: [
        "事件按来源幂等保存，昵称相似不触发人物合并。",
        "Wiki 使用持久失效标记、版本检查及双时间证据截止点。",
        "原文和断言均保留来源范围；页面不是执行权限或动作成功证明。",
      ],
      views: [
        {
          id: "pages",
          title: "Wiki 修订",
          description:
            "只读页面版本、范围、证据与截断状态；历史修订不代表当前有效认识。",
          kinds: [memoryWikiUpdatedInformationKind.kind],
          fields: [
            { path: "entityInformationId", label: "实体" },
            { path: "scopeInformationId", label: "来源范围" },
            { path: "version", label: "版本" },
            { path: "evidenceCutoff", label: "证据截止" },
            { path: "text", label: "页面章节" },
            { path: "sourceInformationIds", label: "原始证据" },
            { path: "truncated", label: "有界截断" },
          ],
        },
        {
          id: "history",
          title: "更新与回填",
          description: "可靠投影任务的结果及因果链。",
          kinds: [memoryKnowledgeCompletedInformationKind.kind],
          fields: [{ path: "status", label: "处理结果" }],
        },
      ],
    },
    settingsSchema: z.object({}).strict(),
    consumes: [
      personContextCompletedInformationKind,
      memoryEventSubmittedInformationKind,
      memoryKnowledgeBackfillInformationKind,
      memoryWikiRefreshInformationKind,
      memoryKnowledgeMutationInformationKind,
      memoryKnowledgeMaintenanceInformationKind,
    ],
    produces: [
      userStatementInformationKind,
      userInputInformationKind,
      userSubjectInformationKind,
      userMemoryScopeInformationKind,
      memoryEventSubmittedInformationKind,
      memoryKnowledgeBackfillInformationKind,
      memoryWikiRefreshInformationKind,
      memoryWikiUpdatedInformationKind,
      memoryKnowledgeCompletedInformationKind,
      memoryKnowledgeMutationInformationKind,
      memoryKnowledgeMaintenanceInformationKind,
    ],
    selectors: [sourceSelector, backfillSelector, backfillEvidenceSelector],
    promptRenderers: [],
    promptTemplates: [memoryIngestionTemplateDeclaration],
    requires: [memoryKnowledgeCapability, memoryKnowledgeBootstrapCapability],
    provides: [],
  },
  create: (_config, lifecycle) => {
    const knowledge = lifecycle.use(memoryKnowledgeCapability);
    return {
      provisions: [],
      ready: () =>
        lifecycle.use(memoryKnowledgeBootstrapCapability).requestBackfill(),
      subscriptions: [
        onInformation(
          memoryKnowledgeMutationInformationKind,
          {
            subscriptionId: "kaguya.memory.knowledge.mutation.v1",
            delivery: "durable",
          },
          async (request, context) => {
            const p = memoryKnowledgeMutationSchema.parse(request.payload);
            const atoms = await context.select(sourceSelector);
            const evidence =
              "evidenceSourceInformationIds" in p.input
                ? p.input.evidenceSourceInformationIds
                : "sourceInformationId" in p.input
                  ? [p.input.sourceInformationId]
                  : [];
            if (
              !request.references.some(
                (r) =>
                  r.relation === "agent:scope" &&
                  r.informationId === p.input.scopeInformationId,
              ) ||
              evidence.some(
                (id) =>
                  !request.references.some(
                    (r) =>
                      r.relation === "agent:source" && r.informationId === id,
                  ) || !atoms.some((a) => a.informationId === id),
              )
            )
              throw new Error("Invalid memory mutation evidence references");
            if (p.operation === "claim") await knowledge.appendClaim(p.input);
            else if (p.operation === "episode")
              await knowledge.putEpisode(p.input);
            else if (p.operation === "revoke-source")
              await knowledge.revokeSource(p.input);
            else
              await knowledge.invalidateEntity({
                ...p.input,
                operationId: request.informationId,
              });
            await context.registerOnce(
              "kaguya.memory.knowledge.maintenance.page.v1",
              request.informationId,
              memoryKnowledgeMaintenanceInformationKind,
              { payload: { after: null } },
            );
            await complete(request, "completed", context);
          },
        ),
        onInformation(
          memoryKnowledgeMaintenanceInformationKind,
          {
            subscriptionId: "kaguya.memory.knowledge.maintenance.v1",
            delivery: "durable",
          },
          async (request, context) => {
            const p =
              memoryKnowledgeMaintenanceInformationKind.payloadSchema.parse(
                request.payload,
              );
            const pages = await knowledge.listDirtyPages({
              limit: PAGE_SIZE,
              ...(p.after ? { after: p.after } : {}),
            });
            for (const page of pages)
              await schedulePage(
                page.scopeInformationId,
                page.entityInformationId,
                knowledge,
                context,
              );
            if (pages.length === PAGE_SIZE) {
              const last = pages.at(-1)!;
              const after = {
                scopeInformationId: last.scopeInformationId,
                entityInformationId: last.entityInformationId,
              };
              await context.registerOnce(
                "kaguya.memory.knowledge.maintenance.page.v1",
                request.informationId,
                memoryKnowledgeMaintenanceInformationKind,
                { payload: { after } },
              );
            }
            await complete(request, "completed", context);
          },
        ),
        onInformation(
          personContextCompletedInformationKind,
          {
            subscriptionId: "kaguya.memory.knowledge.identity.v1",
            delivery: "durable",
          },
          async (identity, context) => {
            await seedIdentity(
              identity,
              await context.select(sourceSelector),
              context,
            );
          },
        ),
        onInformation(
          memoryEventSubmittedInformationKind,
          {
            subscriptionId: "kaguya.memory.knowledge.event.v1",
            delivery: "durable",
          },
          async (request, context) => {
            await handleEvent(
              request,
              await context.select(sourceSelector),
              knowledge,
              context,
            );
          },
        ),
        onInformation(
          memoryWikiRefreshInformationKind,
          {
            subscriptionId: "kaguya.memory.knowledge.wiki.v1",
            delivery: "durable",
          },
          async (request, context) => {
            const authorized = await context.select(sourceSelector);
            await refreshPage(request, authorized, knowledge, context);
          },
        ),
        onInformation(
          memoryKnowledgeBackfillInformationKind,
          {
            subscriptionId: "kaguya.memory.knowledge.backfill.v1",
            delivery: "durable",
          },
          async (request, context) => {
            const p =
              memoryKnowledgeBackfillInformationKind.payloadSchema.parse(
                request.payload,
              );
            const page = await context.select(backfillSelector);
            const atoms = await context.select(backfillEvidenceSelector);
            for (const atom of page) {
              context.signal.throwIfAborted();
              if (atom.kind === personContextCompletedInformationKind.kind)
                await seedIdentity(atom, atoms, context);
              else await handleEvent(atom, atoms, knowledge, context);
            }
            if (page.length === PAGE_SIZE)
              await context.registerOnce(
                "kaguya.memory.knowledge.backfill.page.v1",
                JSON.stringify([
                  request.informationId,
                  page.at(-1)!.informationId,
                ]),
                memoryKnowledgeBackfillInformationKind,
                {
                  payload: {
                    ...p,
                    afterInformationId: page.at(-1)!.informationId,
                  },
                },
              );
            await complete(request, "completed", context);
          },
        ),
      ],
    };
  },
});

async function seedIdentity(
  identity: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const p = personContextCompletedInformationKind.payloadSchema.parse(
    identity.payload,
  );
  if (p.scopeMode !== "canonical" || typeof p.scopeInformationId !== "string")
    return;
  const sourceId = identity.references.find(
    (r) => r.relation === "core:status-of",
  )?.informationId;
  const source = atoms.find(
    (a) =>
      a.informationId === sourceId &&
      a.kind === inboundTextInformationKind.kind,
  );
  if (!source) throw new Error("Missing knowledge message source");
  const message = inboundTextInformationKind.payloadSchema.parse(
    source.payload,
  );
  if (!message.text.trim() || message.text.length > 16000) return;
  const actor =
    p.status === "complete" && typeof p.personInformationId === "string"
      ? {
          status: "resolved" as const,
          entityInformationId: p.personInformationId,
        }
      : {
          status: "unresolved" as const,
          label: message.source.senderId || "unknown",
        };
  await context.registerOnce(
    "kaguya.memory.knowledge.event.v1",
    source.informationId,
    memoryEventSubmittedInformationKind,
    {
      payload: {
        sourceInformationId: source.informationId,
        scopeInformationId: p.scopeInformationId,
        occurredAt: source.occurredAt,
        content: message.text,
        eventType: "message",
        actor,
        subjects: [],
        ...(message.source.replyTo
          ? {
              replyTo: {
                externalMessageId: message.source.replyTo.platformMessageId,
              },
            }
          : {}),
      },
      references: [
        { relation: "agent:source", informationId: source.informationId },
        { relation: "agent:scope", informationId: p.scopeInformationId },
        ...(actor.status === "resolved"
          ? [
              {
                relation: "agent:entity",
                informationId: actor.entityInformationId,
              },
            ]
          : []),
      ],
    },
  );
}

async function recordEvent(
  request: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
  knowledge: MemoryKnowledgeAccess,
  context: InformationModuleHandlerContext,
) {
  const p = memoryEventInputSchema.parse(request.payload);
  if (
    !request.references.some(
      (r) =>
        r.relation === "agent:source" &&
        r.informationId === p.sourceInformationId,
    ) ||
    !request.references.some(
      (r) =>
        r.relation === "agent:scope" &&
        r.informationId === p.scopeInformationId,
    )
  )
    throw new KnowledgeEvidenceError();
  const source = atoms.find((a) => a.informationId === p.sourceInformationId);
  if (!source) throw new KnowledgeEvidenceError();
  context.signal.throwIfAborted();
  await knowledge.putEvent(p);
  if (
    source.kind === inboundTextInformationKind.kind &&
    p.actor.status === "resolved"
  ) {
    const message = inboundTextInformationKind.payloadSchema.parse(
      source.payload,
    );
    // 名称只是平台观察；不从消息正文猜测被谈论者或把转述当本人的偏好。
    for (const [predicate, value] of Object.entries({
      nickname: message.source.sender?.nickname,
      card: message.source.sender?.card,
    })) {
      if (!value) continue;
      await knowledge.appendClaim({
        claimId: `${source.informationId}:${predicate}`,
        scopeInformationId: p.scopeInformationId,
        subjectInformationId: p.actor.entityInformationId,
        predicate: `observed.${predicate}`,
        value,
        epistemic: "fact",
        validFrom: source.occurredAt,
        evidenceSourceInformationIds: [source.informationId],
      });
    }
  }
  const entities = new Set([
    p.scopeInformationId,
    ...[p.actor, ...p.subjects].flatMap((r) =>
      r.status === "resolved" ? [r.entityInformationId] : [],
    ),
  ]);
  for (const entityInformationId of entities)
    await schedulePage(
      p.scopeInformationId,
      entityInformationId,
      knowledge,
      context,
    );
  await complete(request, "completed", context);
}

async function handleEvent(
  request: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
  knowledge: MemoryKnowledgeAccess,
  context: InformationModuleHandlerContext,
) {
  try {
    await recordEvent(request, atoms, knowledge, context);
  } catch (error) {
    if (
      !(error instanceof KnowledgeEvidenceError) &&
      !(error instanceof MemoryWikiConflictError) &&
      !(error instanceof z.ZodError)
    )
      throw error;
    await complete(request, "skipped", context);
  }
}

async function schedulePage(
  scopeInformationId: string,
  entityInformationId: string,
  knowledge: MemoryKnowledgeAccess,
  context: InformationModuleHandlerContext,
) {
  const page = await knowledge.readWikiPage({
    scopeInformationId,
    entityInformationId,
  });
  if (!page?.dirty) return;
  const now = context.now().toISOString();
  const evidenceCutoff = { occurredBefore: now, recordedBefore: now };
  const recall = await knowledge.recall({
    scopeInformationId,
    ...(scopeInformationId === entityInformationId
      ? {}
      : { entityInformationId }),
    ...evidenceCutoff,
    limit: 8,
  });
  await context.registerOnce(
    "kaguya.memory.knowledge.refresh.v1",
    JSON.stringify([
      scopeInformationId,
      entityInformationId,
      page.version,
      page.dirtyVersion,
    ]),
    memoryWikiRefreshInformationKind,
    {
      payload: {
        scopeInformationId,
        entityInformationId,
        expectedVersion: page.version,
        expectedDirtyVersion: page.dirtyVersion,
        evidenceCutoff,
        evidenceSourceInformationIds: [...recall.evidenceSourceInformationIds],
      },
      references: [
        { relation: "agent:scope", informationId: scopeInformationId },
        { relation: "agent:entity", informationId: entityInformationId },
      ],
    },
  );
}

async function refreshPage(
  request: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
  knowledge: MemoryKnowledgeAccess,
  context: InformationModuleHandlerContext,
) {
  const p = memoryWikiRefreshInformationKind.payloadSchema.parse(
    request.payload,
  );
  const recall = await knowledge.recall({
    scopeInformationId: p.scopeInformationId,
    ...(p.scopeInformationId === p.entityInformationId
      ? {}
      : { entityInformationId: p.entityInformationId }),
    ...p.evidenceCutoff,
    limit: 8,
  });
  const allowed = new Set(atoms.map((a) => a.informationId));
  if (
    recall.evidenceSourceInformationIds.some(
      (id) => !allowed.has(id) || !p.evidenceSourceInformationIds.includes(id),
    )
  )
    throw new Error("Wiki evidence changed outside frozen closure");
  const sections: WikiSection[] = [
    ...recall.events.slice(0, 8).map((event) => ({
      heading: `${event.occurredAt} · ${event.eventType}`,
      content: `原始经历（${event.actor.status === "resolved" ? event.actor.entityInformationId : event.actor.label}）${event.actionStatus ? `；动作阶段：${event.actionStatus}` : ""}\n${event.content.slice(0, 3000)}`,
      evidenceSourceInformationIds: [event.sourceInformationId],
      claimIds: [],
    })),
    ...recall.claims.slice(0, 8).map((claim) => ({
      heading: `${claim.predicate} · ${claim.epistemic}`,
      content: `主体：${claim.subjectInformationId}；陈述者：${claim.speakerInformationId ?? "来源观察"}；有效起点：${claim.validFrom}\n${claim.value.slice(0, 3000)}`,
      evidenceSourceInformationIds: [...claim.evidenceSourceInformationIds],
      claimIds: [claim.claimId],
    })),
  ];
  try {
    const revision = await knowledge.writeWikiRevision({
      operationId: request.informationId,
      scopeInformationId: p.scopeInformationId,
      entityInformationId: p.entityInformationId,
      expectedVersion: p.expectedVersion,
      expectedDirtyVersion: p.expectedDirtyVersion,
      evidenceCutoff: p.evidenceCutoff,
      generatorVersion: GENERATOR_VERSION,
      sections,
    });
    const current = await knowledge.readWikiPage({
      scopeInformationId: p.scopeInformationId,
      entityInformationId: p.entityInformationId,
    });
    if (
      current?.dirty ||
      current?.latestRevision?.version !== revision.version
    ) {
      await complete(request, "superseded", context);
      return;
    }
    const sources = [
      ...new Set(
        revision.sections.flatMap((s) => s.evidenceSourceInformationIds),
      ),
    ];
    await context.registerOnce(
      "kaguya.memory.knowledge.revision.v1",
      JSON.stringify([
        p.scopeInformationId,
        p.entityInformationId,
        revision.version,
      ]),
      memoryWikiUpdatedInformationKind,
      {
        payload: {
          scopeInformationId: p.scopeInformationId,
          entityInformationId: p.entityInformationId,
          version: revision.version,
          generatorVersion: revision.generatorVersion,
          evidenceCutoff: revision.evidenceCutoff,
          text: revision.sections
            .map(
              (s) =>
                `## ${s.heading}\n${s.content}\n来源：${s.evidenceSourceInformationIds.join(", ")}`,
            )
            .join("\n\n"),
          sourceInformationIds: sources,
          truncated:
            recall.truncated ||
            recall.events.some((e) => e.content.length > 3000) ||
            recall.claims.some((c) => c.value.length > 3000),
        },
        references: [
          { relation: "agent:scope", informationId: p.scopeInformationId },
          { relation: "agent:entity", informationId: p.entityInformationId },
          ...sources.map((informationId) => ({
            relation: "agent:source",
            informationId,
          })),
        ],
      },
    );
    await complete(request, "completed", context);
  } catch (error) {
    if (
      !(error instanceof MemoryWikiConflictError) &&
      !(error instanceof KnowledgeEvidenceError)
    )
      throw error;
    await schedulePage(
      p.scopeInformationId,
      p.entityInformationId,
      knowledge,
      context,
    );
    await complete(request, "superseded", context);
  }
}

async function complete(
  request: DeepReadonly<InformationAtom>,
  status: "completed" | "skipped" | "superseded",
  context: InformationModuleHandlerContext,
) {
  await context.commitTerminal(
    "kaguya.memory.knowledge.terminal.v1",
    request.informationId,
    memoryKnowledgeCompletedInformationKind,
    {
      payload: { status },
      references: [
        { relation: "core:status-of", informationId: request.informationId },
      ],
    },
  );
}
