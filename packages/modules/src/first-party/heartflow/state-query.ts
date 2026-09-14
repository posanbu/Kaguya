/**
 * 功能概述：Heartflow 的账本水合与分页查询边界，从在线编排入口提取。
 * 主要职责：hydrateCandidate、candidatesForClaims、related 各自维护候选、claim、身份和终态之间的关系。
 * 代码库关系：index.ts 负责推进与提交，本文件只读取 Selector Ledger 并返回事实，不写数据库；外部 Information 协议保持不变。
 */
import { focusOpened, focusRenewed } from "../attention-focus/facts.js";
import {
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
} from "@kaguya/schema";
import { type InformationSelectorLedger } from "@kaguya/sdk";
import {
  observationWakeInformationKind,
  inboundTextInformationKind,
  turnClaimedInformationKind,
} from "../information-kinds.js";
import { uniqueAtoms } from "./turn-state.js";

export async function hydrateCandidate(
  ledger: InformationSelectorLedger,
  candidate: DeepReadonly<InformationAtom>,
  remember: (
    atoms: readonly DeepReadonly<InformationAtom>[],
  ) => readonly DeepReadonly<InformationAtom>[],
) {
  remember(
    await related(ledger, candidate.informationId, "core:context", "outgoing"),
  );
  const inbounds = remember(
    await related(
      ledger,
      candidate.informationId,
      "core:uses-context",
      "outgoing",
      1_000,
    ),
  ).filter(({ kind }) => kind === inboundTextInformationKind.kind);
  const source = (inbounds.at(-1)?.payload as any)?.source;
  if (source !== undefined) {
    const asOfMs = Date.parse((candidate.payload as any).asOf);
    const occurredBefore = new Date(asOfMs + 1).toISOString();
    remember(
      await ledger.find({
        kinds: [inboundTextInformationKind.kind],
        occurredAfter: new Date(asOfMs - 30 * 60_000).toISOString(),
        occurredBefore,
        payloadContains: {
          source: {
            platform: source.platform,
            adapterId: source.adapterId,
            destination: source.destination,
          },
        },
        order: "asc",
        limit: 1_000,
      }),
    );
    remember(
      await ledger.find({
        kinds: ["core.delivery.delivered"],
        occurredAfter: new Date(asOfMs - 30 * 60_000).toISOString(),
        occurredBefore,
        payloadContains: {
          ok: true,
          platform: source.platform,
          adapterId: source.adapterId,
          target: source.destination,
        },
        order: "asc",
        limit: 1_000,
      }),
    );
    const repliedMessageId = source.replyTo?.platformMessageId;
    if (typeof repliedMessageId === "string") {
      remember(
        await ledger.find({
          kinds: ["core.delivery.delivered"],
          occurredBefore,
          payloadContains: {
            ok: true,
            platform: source.platform,
            adapterId: source.adapterId,
            target: source.destination,
            platformMessageId: repliedMessageId,
          },
          order: "desc",
          limit: 1,
        }),
      );
    }
  }
  for (const inbound of inbounds) {
    remember(
      await related(
        ledger,
        inbound.informationId,
        "core:status-of",
        "incoming",
        100,
      ),
    );
  }
  remember(
    await related(
      ledger,
      candidate.informationId,
      "core:status-of",
      "incoming",
      10,
    ),
  );
  const candidateLinks = remember(
    await related(
      ledger,
      candidate.informationId,
      "agent:turn-candidate",
      "incoming",
      10,
    ),
  );
  const ownClaims = candidateLinks.filter(
    (a) => a.kind === turnClaimedInformationKind.kind,
  );
  for (const wake of candidateLinks.filter(
    (a) => a.kind === observationWakeInformationKind.kind,
  )) {
    const inputs = remember(
      await related(
        ledger,
        wake.informationId,
        "core:uses-context",
        "outgoing",
        1000,
      ),
    );
    for (const input of inputs)
      remember(
        await related(
          ledger,
          input.informationId,
          "core:status-of",
          "incoming",
          100,
        ),
      );
  }
  const scopeKey = (candidate.payload as any).scopeKey;
  const focusGrants = remember(
    await ledger.find({
      kinds: [focusOpened.kind, focusRenewed.kind],
      payloadContains: { scopeKey },
      order: "desc",
      registrationOrder: true,
      limit: 16,
    }),
  );
  if (focusGrants.length)
    remember(
      await ledger.related({
        from: focusGrants.map((a) => a.informationId),
        relation: "core:status-of",
        direction: "incoming",
        limit: 100,
      }),
    );
  const claims = remember(
    await ledger.find({
      kinds: [turnClaimedInformationKind.kind],
      scopeKey,
      registrationOrder: true,
      order: "desc",
      limit: 1,
    }),
  );
  for (const claim of uniqueAtoms([...claims, ...ownClaims])) {
    remember(
      await related(
        ledger,
        claim.informationId,
        "agent:turn-claim",
        "incoming",
        100,
      ),
    );
    const recoveryInputs = remember(
      await related(
        ledger,
        claim.informationId,
        "core:uses-context",
        "outgoing",
        1000,
      ),
    );
    for (const inbound of recoveryInputs)
      remember(
        await related(
          ledger,
          inbound.informationId,
          "core:status-of",
          "incoming",
          100,
        ),
      );

    const claimCandidates = remember(
      await related(
        ledger,
        claim.informationId,
        "agent:turn-candidate",
        "outgoing",
      ),
    );
    remember(
      await related(
        ledger,
        claim.informationId,
        "core:status-of",
        "incoming",
        10,
      ),
    );
    for (const claimedCandidate of claimCandidates) {
      remember(
        await related(
          ledger,
          claimedCandidate.informationId,
          "core:context",
          "outgoing",
        ),
      );
      remember(
        await related(
          ledger,
          claimedCandidate.informationId,
          "core:status-of",
          "incoming",
          10,
        ),
      );
    }
  }
}

export async function candidatesForClaims(
  ledger: InformationSelectorLedger,
  claims: readonly DeepReadonly<InformationAtom>[],
  remember: (
    atoms: readonly DeepReadonly<InformationAtom>[],
  ) => readonly DeepReadonly<InformationAtom>[],
) {
  return remember(
    (
      await Promise.all(
        claims.map((claim) =>
          related(
            ledger,
            claim.informationId,
            "agent:turn-candidate",
            "outgoing",
          ),
        ),
      )
    ).flat(),
  );
}

export async function related(
  ledger: InformationSelectorLedger,
  from: string,
  relation: string,
  direction: "outgoing" | "incoming",
  limit = 10,
) {
  const atoms: DeepReadonly<InformationAtom>[] = [];
  let offset = 0;
  for (;;) {
    const page = await ledger.related({
      from: [from as InformationId],
      relation,
      direction,
      limit,
      offset,
    });
    atoms.push(...page);
    if (
      relation !== "core:uses-context" ||
      limit !== 1000 ||
      page.length < limit
    )
      return atoms;
    offset += page.length;
  }
}
