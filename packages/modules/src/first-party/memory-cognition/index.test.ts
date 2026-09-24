/**
 * 功能概述：验证在线认知快照选择只消费已完成、同范围、同 provider 版本的证据。
 * ledger 测试替身记录明确来源链，覆盖多人群聊、空快照替代旧事实、跨范围、未来证据
 * 和 Web conversationId 范围隔离；模块 worker 使用持久化文档替身验证冻结截止点、
 * 来源一致性、版本迁移和请求隔离；Web 隔离不改变 Identity 对长期认知的准入限制，
 * 不调用外部模型，不模拟或实现任何事实演化算法。
 */
import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_COGNITION_EVIDENCE_GUARD_STRATEGY_ID,
  memoryCognitionCapability,
  type MemoryDocument,
  type MemoryCognitionInput,
} from "@kaguya/memory";
import {
  cognitionScopeKey,
  createCognitionMemorySelector,
  memoryCognitionModule,
} from "./index.js";
const source = {
  platform: "qq",
  adapterId: "qq",
  senderId: "user",
  platformMessageId: "message",
  destination: { kind: "group" as const, groupId: "group" },
};
const base = {
  occurredAt: "2026-09-01T00:00:00.000Z",
  source: "module:test",
  references: [],
};
const inbound: any = {
  ...base,
  informationId: "inbound",
  kind: "core.message.inbound.text",
  payload: { text: "hello", source },
};
const candidate: any = {
  ...base,
  informationId: "candidate",
  kind: "agent.turn.candidate",
  payload: {
    asOf: "2026-09-01T00:01:00.000Z",
    scopeKey: "qq:qq:group:group",
    platform: source.platform,
    adapterId: source.adapterId,
    destination: source.destination,
    unreadThroughInformationId: inbound.informationId,
  },
};
const observation: any = {
  ...base,
  informationId: "observation",
  kind: "agent.attention.arousal.completed",
  payload: {
    outcome: "observe",
    arousalState: "awake",
    arousalStateInformationId: "arousal-state",
    wakeSignal: false,
    candidateInformationId: "candidate",
  },
};
const memory: any = {
  ...base,
  informationId: "memory",
  kind: "memory.text",
  references: [{ relation: "core:uses-context", informationId: "inbound" }],
  payload: { text: "provider fact" },
};
const identity = { providerId: "test", revision: "v1" };
const snapshot: any = {
  ...base,
  informationId: "snapshot",
  kind: "memory.cognition.completed",
  payload: {
    identity,
    scopeKey: cognitionScopeKey(source),
    asOf: base.occurredAt,
    status: "completed",
    memoryInformationId: "memory",
  },
};
async function select(
  snapshots = [snapshot],
  evidence = [inbound],
  selectedMemory = memory,
  options: {
    requireEvidenceGuard?: boolean;
    retrieve?: () => Promise<any[]>;
    current?: any;
  } = {},
) {
  const find = vi.fn(async (query: any) =>
    query.kinds?.includes("core.message.inbound.text")
      ? [options.current ?? inbound]
      : snapshots,
  );
  const retrieve = vi.fn(options.retrieve ?? (async () => evidence));
  const ids = await createCognitionMemorySelector(identity, {
    requireEvidenceGuard: options.requireEvidenceGuard ?? false,
  }).select({
    sourceAtom: candidate,
    ledger: {
      find,
      retrieve,
      related: async (query) =>
        query.from[0] === "candidate" && query.relation === "core:status-of"
          ? [observation]
          : query.relation === "agent:evidence"
            ? evidence
            : [selectedMemory],
    },
  });
  return { ids, find, retrieve };
}
describe("completed cognition selection", () => {
  it("selects a snapshot with its exact provider, scope and cutoff", async () => {
    const result = await select();
    expect(result.ids).toEqual(["memory"]);
    expect(result.find).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadContains: { identity, scopeKey: snapshot.payload.scopeKey },
        occurredBefore: candidate.payload.asOf,
      }),
    );
  });
  it("lets a newer empty snapshot supersede older facts", async () => {
    const result = await select([
      snapshot,
      {
        ...snapshot,
        informationId: "empty",
        payload: {
          ...snapshot.payload,
          status: "empty",
          memoryInformationId: null,
          asOf: "2026-09-01T00:00:30.000Z",
        },
      },
    ]);
    expect(result.ids).toEqual([]);
  });
  it("rejects evidence from another chat scope", async () => {
    const result = await select(
      [snapshot],
      [
        {
          ...inbound,
          payload: {
            ...inbound.payload,
            source: {
              ...source,
              destination: { kind: "group", groupId: "other" },
            },
          },
        },
      ],
    );
    expect(result.ids).toEqual([]);
  });
  it("accepts exact evidence from different participants in the same group", async () => {
    const correction = {
      ...inbound,
      informationId: "correction",
      payload: {
        text: "那是以前，现在已经不喝咖啡了",
        source: { ...source, senderId: "speaker-b" },
      },
    };
    const result = await select([snapshot], [inbound, correction], {
      ...memory,
      references: [inbound, correction].map((atom) => ({
        relation: "core:uses-context",
        informationId: atom.informationId,
      })),
    });
    expect(result.ids).toEqual(["memory"]);
  });
  it("rejects a snapshot whose direct evidence is newer than its declared cutoff", async () => {
    const result = await select(
      [snapshot],
      [
        {
          ...inbound,
          occurredAt: "2026-09-01T00:00:30.000Z",
        },
      ],
    );
    expect(result.ids).toEqual([]);
  });
  it("checks the full snapshot closure when Knowledge is enabled", async () => {
    const result = await select([snapshot], [inbound], memory, {
      requireEvidenceGuard: true,
    });
    expect(result.ids).toEqual(["memory"]);
    expect(result.retrieve).toHaveBeenCalledWith({
      strategyId: MEMORY_COGNITION_EVIDENCE_GUARD_STRATEGY_ID,
      input: { sourceInformationIds: ["inbound"] },
      limit: 1,
    });
  });
  it("rejects the whole snapshot if any evidence was revoked", async () => {
    const second = { ...inbound, informationId: "second" };
    const result = await select(
      [snapshot],
      [inbound, second],
      {
        ...memory,
        references: [inbound, second].map((atom) => ({
          relation: "core:uses-context",
          informationId: atom.informationId,
        })),
      },
      {
        requireEvidenceGuard: true,
        retrieve: async () => [inbound],
      },
    );
    expect(result.ids).toEqual([]);
    expect(result.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { sourceInformationIds: ["inbound", "second"] },
        limit: 2,
      }),
    );
  });
  it("fails closed when an enabled guard is missing, broken or returns other evidence", async () => {
    const unavailable = await select([snapshot], [inbound], memory, {
      requireEvidenceGuard: true,
      retrieve: async () => {
        throw new Error("Unknown retrieval strategy");
      },
    });
    expect(unavailable.ids).toEqual([]);
    const substituted = await select([snapshot], [inbound], memory, {
      requireEvidenceGuard: true,
      retrieve: async () => [{ ...inbound, informationId: "unrelated" }],
    });
    expect(substituted.ids).toEqual([]);
  });
  it("retains the existing cognition baseline without Knowledge", async () => {
    const result = await select([snapshot], [inbound], memory, {
      requireEvidenceGuard: false,
      retrieve: async () => {
        throw new Error("guard should not be invoked");
      },
    });
    expect(result.ids).toEqual(["memory"]);
    expect(result.retrieve).not.toHaveBeenCalled();
  });
});

const windowSelector = memoryCognitionModule.manifest.selectors.find(
  (selector) => selector.selectorId === "memory.cognition.window",
)!;
async function selectWindow(
  history: any[],
  trigger = inbound,
  scopeMode = "canonical",
) {
  const find = vi.fn(async () => history);
  const ids = await windowSelector.select({
    sourceAtom: {
      ...base,
      informationId: "writeback-completed",
      kind: "memory.writeback.completed",
      payload: {},
    },
    ledger: {
      find,
      retrieve: async () => [],
      related: async (query) => {
        if (query.relation === "core:status-of")
          return [
            {
              ...base,
              informationId: "writeback-request",
              kind: "memory.writeback.requested",
              payload: {},
            },
          ];
        if (query.relation === "core:caused-by")
          return [
            {
              ...base,
              informationId: "identity",
              kind: "memory.identity.person.context.completed",
              payload: {
                scopeMode,
                status: "complete",
                personInformationId: "person",
              },
            },
          ];
        return [trigger];
      },
    },
  });
  return { ids, find };
}
describe("bounded scene cognition window", () => {
  it("keeps the latest 32 group messages with multiple speakers and deterministic order", async () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      ...inbound,
      informationId: `history-${String(index).padStart(2, "0")}`,
      occurredAt: new Date(
        Date.parse(base.occurredAt) - (index + 1) * 1000,
      ).toISOString(),
      payload: {
        ...inbound.payload,
        source: { ...source, senderId: index % 2 ? "speaker-a" : "speaker-b" },
      },
    }));
    const { ids, find } = await selectWindow(history);
    expect(ids).toHaveLength(32);
    expect(ids).toEqual(
      [...history.slice(0, 31)]
        .reverse()
        .map((atom) => atom.informationId)
        .concat("inbound"),
    );
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadContains: {
          source: {
            platform: "qq",
            adapterId: "qq",
            destination: source.destination,
          },
        },
        occurredBefore: inbound.occurredAt,
        limit: 32,
      }),
    );
  });
  it("rejects future, duplicate and cross-scene evidence even if returned by a reader", async () => {
    const result = await selectWindow([
      inbound,
      {
        ...inbound,
        informationId: "future",
        occurredAt: "2026-09-01T00:00:01.000Z",
      },
      {
        ...inbound,
        informationId: "foreign",
        payload: {
          ...inbound.payload,
          source: { ...source, adapterId: "other-adapter" },
        },
      },
      {
        ...inbound,
        informationId: "other-group",
        payload: {
          ...inbound.payload,
          source: {
            ...source,
            destination: { kind: "group", groupId: "other" },
          },
        },
      },
    ]);
    expect(result.ids).toEqual(["inbound"]);
  });
  it("preserves the private sender boundary and excludes ephemeral triggers", async () => {
    const trigger = {
      ...inbound,
      payload: {
        ...inbound.payload,
        source: { ...source, destination: { kind: "private", userId: "user" } },
      },
    };
    const result = await selectWindow(
      [
        {
          ...trigger,
          informationId: "other-sender",
          payload: {
            ...trigger.payload,
            source: { ...trigger.payload.source, senderId: "other" },
          },
        },
      ],
      trigger,
    );
    expect(result.ids).toEqual(["inbound"]);
    expect(result.find).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadContains: {
          source: {
            platform: "qq",
            adapterId: "qq",
            senderId: "user",
            destination: { kind: "private", userId: "user" },
          },
        },
      }),
    );
    expect((await selectWindow([], inbound, "ephemeral")).ids).toEqual([]);
  });
});

function asDocument(atom: any): MemoryDocument {
  const address = atom.payload.source;
  return {
    memoryId: `memory-${atom.informationId}`,
    sourceInformationId: atom.informationId,
    sourceKind: atom.kind,
    content: atom.payload.text,
    occurredAt: atom.occurredAt,
    createdAt: base.occurredAt,
    address: {
      platform: address.platform,
      adapterId: address.adapterId,
      accountId: address.senderId,
      platformMessageId: address.platformMessageId,
      destination: address.destination,
    },
  };
}
async function executeCognition(
  documents: MemoryDocument[],
  evidence = [inbound],
  payload = snapshot.payload,
) {
  const evolve = vi.fn(
    async (_input: MemoryCognitionInput, _signal: AbortSignal) => ({
      facts: [],
    }),
  );
  const commitTerminal = vi.fn();
  const registerOnce = vi.fn(async () => memory);
  const instance = await memoryCognitionModule.create(
    {
      instanceId: "cognition",
      activation: {
        instanceId: "cognition",
        definitionId: memoryCognitionModule.manifest.definitionId,
      },
      settings: {},
    },
    {
      signal: new AbortController().signal,
      now: () => new Date(candidate.payload.asOf),
      report: async () => undefined,
      use: (capability) =>
        (capability.id === memoryCognitionCapability.id
          ? { identity, evolve }
          : {
              getBySource: async (id: string) =>
                documents.find((doc) => doc.sourceInformationId === id),
            }) as never,
    },
  );
  const request = {
    ...base,
    occurredAt: candidate.payload.asOf,
    informationId: "request",
    kind: "memory.cognition.requested",
    payload: {
      identity: payload.identity,
      scopeKey: payload.scopeKey,
      asOf: payload.asOf,
      sourceInformationIds: evidence.map((atom) => atom.informationId),
    },
  };
  await instance.subscriptions[1]!.handle(request, {
    signal: new AbortController().signal,
    select: async () => evidence,
    registerOnce,
    commitTerminal,
  } as any);
  return { evolve, commitTerminal, registerOnce };
}
describe("frozen cognition evidence execution", () => {
  it("passes a frozen multi-speaker scene with an operation-specific key", async () => {
    const other = {
      ...inbound,
      informationId: "other",
      payload: {
        text: "这是我以前的偏好",
        source: { ...source, senderId: "speaker-b" },
      },
    };
    const f = await executeCognition(
      [asDocument(inbound), asDocument(other)],
      [inbound, other],
    );
    expect(f.evolve).toHaveBeenCalledOnce();
    const input = f.evolve.mock.calls[0]![0] as any;
    expect(input.operationKey).toBe("request");
    expect(
      input.documents.map((doc: MemoryDocument) => doc.address.accountId),
    ).toEqual(["user", "speaker-b"]);
    expect(Object.isFrozen(input.documents[1].address)).toBe(true);
    expect(f.commitTerminal.mock.calls[0]![3].payload.status).toBe("empty");
  });
  it.each(["event-time", "recording-time", "body", "scope"])(
    "rejects invalid %s before invoking the provider",
    async (violation) => {
      const doc = asDocument(inbound);
      const evidence = [{ ...inbound }];
      if (violation === "event-time") {
        evidence[0]!.occurredAt = "2026-09-01T00:00:30.000Z";
        (doc as any).occurredAt = evidence[0]!.occurredAt;
      }
      if (violation === "recording-time")
        (doc as any).createdAt = "2026-09-01T00:02:00.000Z";
      if (violation === "body") (doc as any).content = "替换后的正文";
      const payload =
        violation === "scope"
          ? {
              ...snapshot.payload,
              scopeKey: cognitionScopeKey({ ...source, adapterId: "other" }),
            }
          : snapshot.payload;
      const f = await executeCognition([doc], evidence, payload);
      expect(f.evolve).not.toHaveBeenCalled();
      expect(f.registerOnce).not.toHaveBeenCalled();
      expect(f.commitTerminal.mock.calls[0]![3].payload.status).toBe("invalid");
    },
  );
  it("replays legacy pending requests within their original single-speaker boundary", async () => {
    const f = await executeCognition([asDocument(inbound)], [inbound], {
      ...snapshot.payload,
      scopeKey: JSON.stringify([
        source.platform,
        source.adapterId,
        source.senderId,
        source.destination,
      ]),
    });
    expect(f.evolve).toHaveBeenCalledOnce();
  });
});

describe("Web cognition scope", () => {
  it("preserves Web conversation boundaries in scope queries and evidence validation", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const webSource = {
      ...source,
      platform: "web",
      adapterId: "web.ui.main",
      destination: { kind: "web" as const, conversationId },
    };
    const webInbound = {
      ...inbound,
      payload: { ...inbound.payload, source: webSource },
    };
    const scopeKey = JSON.stringify([
      "scene.v2",
      "web",
      "web.ui.main",
      "user",
      { kind: "web", conversationId },
    ]);
    const webSnapshot = {
      ...snapshot,
      payload: { ...snapshot.payload, scopeKey },
    };
    const nextSource = { ...webSource, platformMessageId: "next" };
    expect(cognitionScopeKey(nextSource)).toBe(scopeKey);
    expect(
      cognitionScopeKey({ ...webSource, destination: { kind: "web" } }),
    ).toBe(
      JSON.stringify([
        "scene.v2",
        "web",
        "web.ui.main",
        "user",
        { kind: "web" },
      ]),
    );
    const selected = await select([webSnapshot], [webInbound], memory, {
      current: webInbound,
    });
    expect(selected.ids).toEqual(["memory"]);
    expect(selected.find).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadContains: { identity, scopeKey },
      }),
    );
    const rejected = await select(
      [webSnapshot],
      [
        {
          ...webInbound,
          payload: {
            ...webInbound.payload,
            source: {
              ...webSource,
              destination: {
                kind: "web",
                conversationId: "22222222-2222-4222-8222-222222222222",
              },
            },
          },
        },
      ],
      memory,
      { current: webInbound },
    );
    expect(rejected.ids).toEqual([]);
  });
});
