/** Freeze people from the exact raw background, never from a live directory. */
import { defineInformationSelector } from "@kaguya/sdk";
import { z, type NativeMemorySnapshot } from "@kaguya/schema";
import type { NativeMemoryAccess } from "@kaguya/memory";
import { frozenRawContextInformationKind } from "./raw-context.js";

export const backgroundPeopleSelector = defineInformationSelector({
  selectorId: "agent.router.background-people",
  select: async ({ sourceAtom, ledger }) => {
    const raws = await ledger.find({
      kinds: [frozenRawContextInformationKind.kind],
      payloadContains: { turnInformationId: sourceAtom.informationId },
      limit: 1,
    });
    const raw = raws[0];
    if (!raw) throw new Error("Missing frozen raw background");
    const payload = frozenRawContextInformationKind.payloadSchema.parse(
      raw.payload,
    );
    const ids = [
      ...new Set([
        ...payload.global.informationIds,
        ...payload.currentScope.informationIds,
      ]),
    ];
    const selected: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const batch = ids.slice(offset, offset + 1000);
      const atoms = await ledger.find({
        informationIds: batch,
        limit: batch.length,
      });
      if (atoms.length !== batch.length)
        throw new Error("Missing frozen background evidence");
      selected.push(...atoms.map((a) => a.informationId));
    }
    return selected;
  },
});

const observedSourceSchema = z.object({
  platform: z.string().min(1),
  adapterId: z.string().min(1),
  senderId: z.string().min(1),
  selfId: z.string().optional(),
  sender: z
    .object({ nickname: z.string().optional(), card: z.string().optional() })
    .optional(),
  mentions: z
    .array(
      z.union([
        z.object({ kind: z.literal("all") }),
        z.object({ kind: z.literal("user"), id: z.string().min(1) }),
      ]),
    )
    .optional(),
  replyTo: z.object({ senderId: z.string().optional() }).optional(),
});

export async function freezeBackgroundPeople(
  observations: readonly { informationId: string; source: unknown }[],
  memory: Pick<NativeMemoryAccess, "people">,
): Promise<NativeMemorySnapshot["participants"]> {
  const people = new Map<
    string,
    NativeMemorySnapshot["participants"][number]
  >();
  for (const observation of observations) {
    const source = observedSourceSchema.parse(observation.source);
    const references = [
      {
        accountId: source.senderId,
        nickname: source.sender?.nickname ?? null,
        card: source.sender?.card ?? null,
        relation: "participant" as const,
      },
      ...(source.mentions ?? []).flatMap((m) =>
        m.kind === "user"
          ? [
              {
                accountId: m.id,
                nickname: null,
                card: null,
                relation: "mentioned" as const,
              },
            ]
          : [],
      ),
      ...(source.replyTo?.senderId
        ? [
            {
              accountId: source.replyTo.senderId,
              nickname: null,
              card: null,
              relation: "replied-to" as const,
            },
          ]
        : []),
    ];
    for (const reference of references) {
      const key = JSON.stringify([
        source.platform,
        source.adapterId,
        reference.accountId,
      ]);
      const prior = people.get(key);
      people.set(key, {
        ...reference,
        platform: source.platform,
        adapterId: source.adapterId,
        ownerId:
          reference.accountId === source.selfId
            ? "self:kaguya"
            : (prior?.ownerId ?? null),
        nickname: reference.nickname ?? prior?.nickname ?? null,
        card: reference.card ?? prior?.card ?? null,
        sourceIds: [
          ...new Set([...(prior?.sourceIds ?? []), observation.informationId]),
        ],
      });
    }
  }
  const groups = new Map<string, NativeMemorySnapshot["participants"]>();
  for (const person of people.values()) {
    const key = JSON.stringify([person.platform, person.adapterId]);
    groups.set(key, [...(groups.get(key) ?? []), person]);
  }
  await Promise.all(
    [...groups.values()].map(async (group) => {
      const bindings = await memory.people({
        platform: group[0]!.platform,
        adapterId: group[0]!.adapterId,
        accountIds: group.map((p) => p.accountId),
      });
      for (const person of group) {
        if (person.ownerId === "self:kaguya") continue;
        const owners = [
          ...new Set(
            bindings
              .filter((b) => b.accountId === person.accountId)
              .map((b) => b.ownerId),
          ),
        ];
        person.ownerId = owners.length === 1 ? owners[0]! : null;
      }
    }),
  );
  return [...people.values()];
}
