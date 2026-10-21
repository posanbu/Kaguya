/** Resolve only explicit source references. Collection never reads another module's private storage. */
/** Resolve only explicit source references. Collection never reads another module's private storage. */
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
    return (await ledger.find({ informationIds: ids, limit: 100 })).map(
      (a) => a.informationId,
    );
  },
});

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
