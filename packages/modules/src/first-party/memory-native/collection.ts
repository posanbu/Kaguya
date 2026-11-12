/**
 * 功能概述：沿明确账本引用选择 Memory 来源、参与者和原批次恢复事实。
 * 主要职责：sourceSelector 还原调度上下文；sourceParticipants 保留未知归属；currentSpeakerOwner 检查当前有效绑定，恢复只读取原请求和终态。
 * 代码库关系：通过 SDK ledger selector 访问证据，不读取其他模块的私有存储。
 */
import { defineInformationSelector } from "@kaguya/sdk";
import { oneShotDueInformationKind } from "@kaguya/scheduler";
export const sourceSelector = defineInformationSelector({
  selectorId: "memory.native.source",
  select: async ({ sourceAtom, ledger }) => {
    const ids =
      sourceAtom.kind === oneShotDueInformationKind.kind
        ? [String(sourceAtom.payload.scheduleInformationId)]
        : sourceAtom.references
            .filter(
              (r) =>
                r.relation === "core:status-of" ||
                r.relation === "core:uses-context",
            )
            .map((r) => r.informationId);
    const selected = await ledger.find({ informationIds: ids, limit: 100 });
    if (sourceAtom.kind !== oneShotDueInformationKind.kind)
      return selected.map((a) => a.informationId);
    // Due events only reference the schedule. Recover context through its explicit source.
    const sourceIds = selected.flatMap((a) =>
      a.references
        .filter((r) => r.relation === "core:caused-by")
        .map((r) => r.informationId),
    );
    const sources = sourceIds.length
      ? await ledger.find({ informationIds: sourceIds, limit: 100 })
      : [];
    const contextIds = [
      ...new Set(
        sources.flatMap((a) =>
          a.references
            .filter((r) => r.relation === "core:context")
            .map((r) => r.informationId),
        ),
      ),
    ];
    const contexts = contextIds.length
      ? await ledger.find({ informationIds: contextIds, limit: 100 })
      : [];
    return [
      ...selected.map((a) => a.informationId),
      ...contexts
        .filter((a) => a.kind === "core.runtime.context")
        .map((a) => a.informationId),
    ];
  },
});

/** 仅当终态为 canonical complete 且当前有效绑定唯一匹配时，才将发言归属于人物。 */
export async function currentSpeakerOwner(
  source: { platform: string; adapterId: string; senderId: string },
  identity: {
    status?: unknown;
    scopeMode?: unknown;
    personInformationId?: unknown;
  },
  memory: import("@kaguya/memory").NativeMemoryAccess,
): Promise<string | null> {
  if (
    identity.status !== "complete" ||
    identity.scopeMode !== "canonical" ||
    typeof identity.personInformationId !== "string" ||
    !identity.personInformationId
  )
    return null;
  const expected = `person:${identity.personInformationId}`;
  const bindings = await memory.people({
    platform: source.platform,
    adapterId: source.adapterId,
    accountIds: [source.senderId],
  });
  const owners = [
    ...new Set(
      bindings
        .filter((b) => b.accountId === source.senderId)
        .map((b) => b.ownerId),
    ),
  ];
  return owners.length === 1 && owners[0] === expected ? expected : null;
}

/** Resolve explicit account references only. Names never bind identities. */
export async function sourceParticipants(
  source: {
    platform: string;
    adapterId: string;
    senderId: string;
    sender?: { nickname?: string; card?: string };
    mentions?: readonly ({ kind: "all" } | { kind: "user"; id: string })[];
    replyTo?: { senderId?: string };
  },
  speakerOwnerId: string | null,
  memory: import("@kaguya/memory").NativeMemoryAccess,
): Promise<import("@kaguya/memory").MemorySource["participants"]> {
  const related = [
    ...(source.mentions ?? []).flatMap((m) =>
      m.kind === "user"
        ? [{ accountId: m.id, role: "mentioned" as const }]
        : [],
    ),
    ...(source.replyTo?.senderId
      ? [{ accountId: source.replyTo.senderId, role: "replied-to" as const }]
      : []),
  ];
  const bindings = await memory.people({
    platform: source.platform,
    adapterId: source.adapterId,
    accountIds: [...new Set(related.map((p) => p.accountId))],
  });
  return [
    {
      accountId: source.senderId,
      ownerId: speakerOwnerId,
      role: "speaker",
      nickname: source.sender?.nickname ?? null,
      card: source.sender?.card ?? null,
    },
    ...related.map((p) => {
      const owners = [
        ...new Set(
          bindings
            .filter((b) => b.accountId === p.accountId)
            .map((b) => b.ownerId),
        ),
      ];
      return {
        ...p,
        ownerId:
          p.accountId === source.senderId
            ? speakerOwnerId
            : owners.length === 1
              ? owners[0]!
              : null,
        nickname: null,
        card: null,
      };
    }),
  ];
}

/** 恢复只读取原批次的已持久请求与终态，不能用当前模型重新生成历史成功。 */
export const recoveryFormationSelector = defineInformationSelector({
  selectorId: "memory.native.recovery-formation",
  select: async ({ sourceAtom, ledger }) => {
    const requests = await ledger.find({
      kinds: ["memory.native.formation.requested.v1"],
      payloadContains: { batchId: String(sourceAtom.payload.batchId) },
      limit: 1,
    });
    if (!requests[0]) return [];
    const results = await ledger.related({
      from: [requests[0].informationId],
      relation: "core:status-of",
      direction: "incoming",
      limit: 100,
    });
    return [
      requests[0].informationId,
      ...results
        .filter((a) => a.kind === "memory.native.formation.completed.v1")
        .map((a) => a.informationId),
    ];
  },
});
