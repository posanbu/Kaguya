import { describe, it, expect, vi } from "vitest";
import {
  nativeMemoryCapability,
  type NativeMemoryAccess,
} from "@kaguya/memory";
import {
  nativeMemorySnapshotSchema,
  z,
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import {
  defineInformationKind,
  defineModuleCapability,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import {
  createHeavyModule,
  type ModelTaskCapability,
  type ModelTaskRequest,
} from "./index.js";
import {
  memoryRecallRequested,
  memoryRecallCompleted,
  appendRecallResult,
  recallHistory,
} from "./recall.js";
import {
  appendSpeechContext,
  speechStepRequestedInformationKind,
} from "./speech.js";
import { fixture, atom, identity } from "./test-fixtures.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
const token = defineModuleCapability<ModelTaskCapability>(
  "kaguya:model-task",
  1,
);
const completedKind = defineInformationKind({
  kind: "core.model.task.completed",
  displayName: "模型完成",
  description: "测试模型完成",
  payloadSchema: z
    .object({
      taskId: z.string(),
      sourceInformationId: z.string(),
      outputMode: z.literal("object"),
      activation: z
        .object({ instanceId: z.string(), definitionId: z.string() })
        .strict(),
      selectionPolicy: z.object({ tier: z.literal("heavy") }).strict(),
      output: z.json(),
    })
    .strict(),
  references: {},
  log: { enabled: false },
});
const activation = { instanceId: "heavy.test", definitionId: "agent.heavy" };
const snapshot = () =>
  nativeMemorySnapshotSchema.parse({
    version: 1,
    status: "enabled",
    frozenAt: "2026-09-09T00:00:03.000Z",
    scope: "group-a",
    owners: ["person:a"],
    fixed: [],
    recalled: [],
    degraded: [],
    budget: { dynamicCharacters: 0, omittedNodeIds: [] },
  });
type Atom = DeepReadonly<InformationAtom>;
async function harness() {
  const f = fixture();
  const saved = new Map<string, Atom>(f.atoms.map((a) => [a.informationId, a]));
  const registered = new Map<string, Atom>();
  const execute = vi.fn(async (_r: ModelTaskRequest<unknown>) => ({
    status: "completed",
    output: null,
    requestedInformationId: "unused",
    terminalInformationId: "unused",
  }));
  const recall = vi.fn(async () => snapshot());
  const memory = { enabled: true, recall };
  const definition = createHeavyModule({
    modelTaskCapability: token,
    modelTaskCompletedInformationKind: completedKind,
    nativeMemoryCapability,
    promptTemplates: loadFirstPartyPromptTemplates().heavy,
    agentIdentity: identity,
  });
  let current = f.intent as Atom;
  let sequence = 0;
  const context = {
    instanceId: activation.instanceId,
    definitionId: activation.definitionId,
    signal: new AbortController().signal,
    now: () => new Date("2026-09-09T00:00:04Z"),
    report: vi.fn(),
    use: (cap: { id: string }) =>
      cap.id === nativeMemoryCapability.id ? memory : { execute },
    select: async (selector: any) => {
      if (selector.selectorId === "agent.heavy.closed-speech") return [];
      const ledger = {
        find: async (q: any) =>
          [...saved.values()].filter(
            (a) =>
              !q.informationIds || q.informationIds.includes(a.informationId),
          ),
        related: async (q: any) =>
          q.direction === "incoming"
            ? [...saved.values()]
                .filter((a) =>
                  a.references.some(
                    (r) =>
                      r.relation === q.relation &&
                      q.from.includes(r.informationId),
                  ),
                )
                .slice(0, q.limit)
            : [...saved.values()]
                .filter((a) =>
                  q.from.some((id: string) =>
                    saved
                      .get(id)
                      ?.references.some(
                        (r) =>
                          r.relation === q.relation &&
                          r.informationId === a.informationId,
                      ),
                  ),
                )
                .slice(0, q.limit),
      };
      const ids = await selector.select({ sourceAtom: current, ledger });
      return ids.map((id: string) => saved.get(id)!);
    },
    registerOnce: async (
      namespace: string,
      key: string,
      kind: any,
      input: any,
    ) => {
      const slot = namespace + key;
      if (registered.has(slot)) return registered.get(slot)!;
      const result = atom(
        `recall-${++sequence}`,
        kind.kind,
        kind.payloadSchema.parse(input.payload),
        [
          { relation: "core:caused-by", informationId: current.informationId },
          { relation: "core:context", informationId: "runtime-1" },
          ...(input.references ?? []),
        ],
      );
      saved.set(result.informationId, result);
      registered.set(slot, result);
      return result;
    },
  } as unknown as InformationModuleHandlerContext;
  const instance = await definition.create(
    { instanceId: activation.instanceId, activation, settings: {} },
    context,
  );
  async function handle(a: Atom) {
    current = a;
    saved.set(a.informationId, a);
    const sub = instance.subscriptions.find(
      (s) => s.kind === a.kind || (s as any).informationKind?.kind === a.kind,
    );
    // Subscription IDs are stable even when declaration order changes.
    const ids: Record<string, string> = {
      "core.model.task.completed": "kaguya.heavy.model-task-completed",
      [memoryRecallRequested.kind]: "kaguya.heavy.recall",
      [memoryRecallCompleted.kind]: "kaguya.heavy.after-recall",
      [speechStepRequestedInformationKind.kind]: "kaguya.heavy.step",
    };
    const selected =
      sub ??
      instance.subscriptions.find((s) => s.subscriptionId === ids[a.kind]);
    if (!selected) throw new Error(`Missing handler ${a.kind}`);
    await selected.handle(a as never, context);
  }
  const base: CompiledPrompt = {
    kind: "message",
    templateId: "test",
    text: "context",
    templates: [{ name: "test", content: "context" }],
    variables: [
      {
        name: "native_memory",
        content: JSON.stringify(snapshot()),
        informationIds: ["frozen"],
      },
    ],
  };
  function request(
    source: Atom,
    prompt = base,
    contexts: readonly Atom[] = f.atoms,
  ) {
    const r = atom(
      `model-${++sequence}`,
      "core.model.task.requested",
      {
        taskId: "agent.heavy.respond",
        sourceInformationId: source.informationId,
        prompt,
        contextInformationIds: contexts.map((a) => a.informationId),
        activation,
      },
      [{ relation: "core:caused-by", informationId: source.informationId }],
    );
    saved.set(r.informationId, r);
    return r;
  }
  async function complete(r: Atom, output: any) {
    const c = atom(
      `done-${++sequence}`,
      completedKind.kind,
      {
        taskId: "agent.heavy.respond",
        sourceInformationId: String(r.payload.sourceInformationId),
        activation,
        selectionPolicy: { tier: "heavy" },
        outputMode: "object",
        output,
      },
      [{ relation: "core:caused-by", informationId: r.informationId }],
    );
    await handle(c);
  }
  const all = (kind: string) =>
    [...saved.values()].filter((a) => a.kind === kind);
  return {
    f,
    base,
    saved,
    registered,
    execute,
    recall,
    memory,
    handle,
    request,
    complete,
    all,
  };
}
describe("Heavy durable recall", () => {
  it("persists one result, reuses it on replay, and shares two calls across speech segments", async () => {
    const h = await harness();
    await h.complete(h.request(h.f.intent), {
      action: "recall",
      query: "他此前说的工作",
      candidateIds: [],
    });
    expect(h.all("core.assistant.message.text")).toHaveLength(0);
    expect(h.all("agent.heavy.message.ready")).toHaveLength(0);
    const first = h.all(memoryRecallRequested.kind)[0]!;
    await h.handle(first);
    await h.handle(first);
    expect(h.recall).toHaveBeenCalledTimes(1);
    const firstResult = h.all(memoryRecallCompleted.kind)[0]!;
    h.recall.mockRejectedValueOnce(new Error("must not run on result replay"));
    await h.handle(firstResult);
    expect(h.recall).toHaveBeenCalledTimes(1);
    const next = h.execute.mock.calls.at(-1)![0];
    expect(recallHistory(next.prompt)).toHaveLength(1);
    expect(next.contextAtoms.map((a) => a.informationId)).toContain(
      first.informationId,
    );
    await h.complete(h.request(firstResult, next.prompt, next.contextAtoms), {
      action: "message",
      text: "接着刚才的工作话题",
      continuation: "再问近况",
    });
    const step = atom(
      "step-2",
      speechStepRequestedInformationKind.kind,
      speechStepRequestedInformationKind.payloadSchema.parse({
        ...h.f.intent.payload,
        intentInformationId: h.f.intent.informationId,
        stepIndex: 1,
        continuation: "再问近况",
        previousDeliveryInformationId: "delivery-1",
        observedThroughInformationId: "input-1",
        scopeKey: "group-a",
        contextInformationIds: [...h.saved.keys()],
        prompt: appendSpeechContext(next.prompt, "新的表达段", []),
      }),
      [{ relation: "core:context", informationId: "runtime-1" }],
    );
    h.saved.set(step.informationId, step);
    await h.complete(
      h.request(step, step.payload.prompt as unknown as CompiledPrompt, [
        ...h.saved.values(),
      ]),
      { action: "recall", query: "最近状态", candidateIds: [] },
    );
    expect(h.all("agent.heavy.step.observed")).toHaveLength(0);
    const second = h.all(memoryRecallRequested.kind)[1]!;
    await h.handle(second);
    const result = h.all(memoryRecallCompleted.kind)[1]!;
    expect(result.payload.status).toBe("failed");
    await h.handle(result);
    const final = h.execute.mock.calls.at(-1)![0];
    expect(recallHistory(final.prompt)).toHaveLength(2);
    expect(
      final.task.outputSchema.safeParse({
        action: "recall",
        query: "第三次",
        candidateIds: [],
      }).success,
    ).toBe(false);
    await h.complete(h.request(result, final.prompt, final.contextAtoms), {
      action: "message",
      text: "那就聊眼前这件事",
      continuation: null,
    });
    expect(h.all("agent.heavy.step.observed")).toHaveLength(1);
    expect(h.all("agent.heavy.message.ready")).toHaveLength(2);
    expect(h.base.variables.some((v) => v.name === "memory_recall")).toBe(
      false,
    );
  });
});
