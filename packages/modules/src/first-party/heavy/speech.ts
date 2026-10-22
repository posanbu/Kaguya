/** 持久的逐段表达。只在成功投递后冻结下一步，原始请求和已发事实均保持可追溯。 */
import {
  compiledPromptSchema,
  z,
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationSelector,
  type InformationSelectorLedger,
} from "@kaguya/sdk";
import {
  assistantTextInformationKind,
  messageIntentRequestedInformationPayloadSchema,
  turnProvenanceSchema,
} from "../kinds/message.js";

export const pacingSchema = z
  .object({
    baseMs: z.number().nonnegative().default(150),
    perCharacterMs: z.number().nonnegative().default(25),
    minMs: z.number().nonnegative().default(200),
    maxMs: z.number().nonnegative().default(1200),
  })
  .strict()
  .refine((p) => p.minMs <= p.maxMs, "minMs must not exceed maxMs");

export function speechReadyAt(
  startedAt: string,
  stepId: string,
  text: string,
  pacing = pacingSchema.parse({}),
): string {
  let hash = 2166136261;
  for (const character of stepId)
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  const jitter = 0.85 + (hash / 0xffffffff) * 0.3;
  const duration = Math.round(
    Math.min(
      pacing.maxMs,
      Math.max(
        pacing.minMs,
        (pacing.baseMs + pacing.perCharacterMs * Array.from(text).length) *
          jitter,
      ),
    ),
  );
  return new Date(Date.parse(startedAt) + duration).toISOString();
}

const contextReference = {
  required: true,
  multiple: false,
  targetKinds: ["core.runtime.context"],
} as const;
const frozenPromptSchema = compiledPromptSchema
  .extend({
    templates: z
      .array(compiledPromptSchema.shape.templates.element.strict())
      .min(1),
    variables: z.array(compiledPromptSchema.shape.variables.element.strict()),
  })
  .strict();
export const speechReadyInformationKind = defineInformationKind({
  kind: "agent.heavy.message.ready",
  displayName: "消息等待发送",
  description: "已完成正文和展示处理，等待短暂发送节奏，不表示平台已经收到。",
  payloadSchema: assistantTextInformationKind.payloadSchema,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": contextReference,
  },
  log: { enabled: false },
});

export const speechStepRequestedInformationKind = defineInformationKind({
  kind: "agent.heavy.step.requested",
  displayName: "表达接续步骤",
  description: "上一段成功投递后冻结下一段的表达意图、新消息及实际结果。",
  payloadSchema: messageIntentRequestedInformationPayloadSchema
    .extend({
      intentInformationId: z.string().min(1),
      stepIndex: z.int().positive(),
      continuation: z.string().trim().min(1),
      previousDeliveryInformationId: z.string().min(1),
      observedThroughInformationId: z.string().min(1),
      scopeKey: z.string().min(1),
      prompt: frozenPromptSchema,
      contextInformationIds: z.array(z.string().min(1)),
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.delivery.delivered"],
    },
    "core:context": contextReference,
    "core:uses-context": { required: true, multiple: true },
  },
  log: { enabled: false },
});

export const speechObservedInformationKind = defineInformationKind({
  kind: "agent.heavy.step.observed",
  displayName: "接续输入已处理",
  description: "成功完成接续模型调用后确认输入水位，冻结或失败本身不推进观察。",
  payloadSchema: z
    .object({
      stepInformationId: z.string().min(1),
      scopeKey: z.string().min(1),
      observedThroughInformationId: z.string().min(1),
      turn: turnProvenanceSchema,
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.model.task.completed"],
    },
    "core:context": contextReference,
    "core:uses-context": {
      required: true,
      multiple: false,
      targetKinds: [speechStepRequestedInformationKind.kind],
    },
  },
  log: { enabled: false },
});

type Atom = DeepReadonly<InformationAtom>;
export const getSpeechAtom = async (
  ledger: InformationSelectorLedger,
  id: string,
): Promise<Atom> => {
  const atom = (await ledger.find({ informationIds: [id], limit: 1 }))[0];
  if (!atom) throw new Error(`Missing speech evidence: ${id}`);
  return atom;
};

async function getSpeechAtoms(
  ledger: InformationSelectorLedger,
  ids: readonly string[],
): Promise<Atom[]> {
  const atoms: Atom[] = [];
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const batch = ids.slice(offset, offset + 1000);
    atoms.push(
      ...(await ledger.find({ informationIds: batch, limit: batch.length })),
    );
  }
  const indexed = new Map(atoms.map((a) => [a.informationId, a]));
  return ids.map((id) => {
    const atom = indexed.get(id);
    if (!atom) throw new Error(`Missing speech evidence: ${id}`);
    return atom;
  });
}

/** An ended turn must not dispatch a late model result or a recovered timer. */
export const speechClosedSelector = defineInformationSelector({
  selectorId: "agent.heavy.closed-speech",
  select: async ({ sourceAtom, ledger }) => {
    let source = sourceAtom;
    if (source.kind === "core.model.task.completed")
      source = await getSpeechAtom(
        ledger,
        String(source.payload.sourceInformationId),
      );
    if (source.kind === "core.schedule.one-shot.due") {
      const schedule = await getSpeechAtom(
        ledger,
        String(source.payload.scheduleInformationId),
      );
      const input = schedule.payload.input as {
        purpose?: string;
        readyInformationId?: string;
      };
      if (input.purpose !== "heavy-speech") return [];
      source = await getSpeechAtom(ledger, String(input.readyInformationId));
    }
    if (source.kind === "core.delivery.delivered") {
      source = await getSpeechAtom(
        ledger,
        source.references.find((r) => r.relation === "core:status-of")!
          .informationId,
      );
    }
    const turn = source.payload.turn as
      { candidateInformationId?: string } | undefined;
    if (!turn?.candidateInformationId) return [];
    await getSpeechAtom(ledger, turn.candidateInformationId);
    return (
      await ledger.related({
        from: [turn.candidateInformationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 100,
      })
    )
      .filter((a) =>
        [
          "completed",
          "silent",
          "waiting",
          "failed",
          "superseded",
          "interrupted",
        ].some((state) => a.kind === `agent.router.turn.${state}`),
      )
      .map((a) => a.informationId);
  },
});

export const speechStepContextSelector = defineInformationSelector({
  selectorId: "agent.heavy.step-context",
  select: async ({ sourceAtom, ledger }) => {
    const step = speechStepRequestedInformationKind.payloadSchema.parse(
      sourceAtom.payload,
    );
    await getSpeechAtoms(ledger, step.contextInformationIds);
    return [sourceAtom.informationId, ...step.contextInformationIds];
  },
});

export const speechDueSelector = defineInformationSelector({
  selectorId: "agent.heavy.speech-due",
  select: async ({ sourceAtom, ledger }) => {
    const schedule = await getSpeechAtom(
      ledger,
      String(sourceAtom.payload.scheduleInformationId),
    );
    const input = schedule.payload.input as {
      purpose?: string;
      readyInformationId?: string;
    };
    if (input.purpose !== "heavy-speech") return [];
    const ready = await getSpeechAtom(ledger, String(input.readyInformationId));
    if (ready.kind !== speechReadyInformationKind.kind)
      throw new Error("Invalid speech schedule source");
    const contextId = ready.references.find(
      (r) => r.relation === "core:context",
    )!.informationId;
    await getSpeechAtom(ledger, contextId);
    return [schedule.informationId, ready.informationId, contextId];
  },
});

/** Freeze at the delivery's registration boundary. Later input belongs to a later step. */
export const speechDeliveredSelector = defineInformationSelector({
  selectorId: "agent.heavy.speech-delivered",
  select: async ({ sourceAtom, ledger }) => {
    const requestId = sourceAtom.references.find(
      (r) => r.relation === "core:status-of",
    )?.informationId;
    if (!requestId) return [];
    const delivery = await getSpeechAtom(ledger, requestId);
    // Delivery and assistant share the same optional speech metadata.
    const metadata = delivery.payload.speech as
      | {
          continuation?: string | null;
          completedInformationId: string;
          intentInformationId: string;
          stepInformationId: string;
        }
      | undefined;
    if (!metadata?.continuation) return [];
    const previous = await getSpeechAtom(
      ledger,
      metadata.completedInformationId,
    );
    const requestedId = previous.references.find(
      (r) => r.relation === "core:caused-by",
    )!.informationId;
    const requested = await getSpeechAtom(ledger, requestedId);
    const baseIds = requested.payload.contextInformationIds as string[];
    const base = await getSpeechAtoms(ledger, baseIds);
    const intent = await getSpeechAtom(ledger, metadata.intentInformationId);
    const root = messageIntentRequestedInformationPayloadSchema.parse(
      intent.payload,
    );
    const turn = await getSpeechAtom(ledger, root.turn.contextInformationId);
    const step = await getSpeechAtom(ledger, metadata.stepInformationId);
    const after = String(
      step.payload.observedThroughInformationId ??
        turn.payload.observedThroughInformationId,
    );
    const incoming: Atom[] = [];
    let cursor = after;
    for (;;) {
      const page = await ledger.find({
        kinds: ["core.message.inbound.text"],
        payloadContains: { source: root.target },
        afterInformationId: cursor,
        throughInformationId: sourceAtom.informationId,
        registrationOrder: true,
        order: "asc",
        limit: 1000,
      });
      incoming.push(...page);
      if (page.length < 1000) break;
      cursor = page.at(-1)!.informationId;
    }
    const identities: Atom[] = [];
    for (const input of incoming) {
      const terminals = await ledger.related({
        from: [input.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 100,
      });
      const identity = terminals.find(
        (a) => a.kind === "memory.identity.person.context.completed",
      );
      if (!identity)
        throw new Error("Speech continuation awaits input identity");
      if (identity.payload.status === "failed")
        throw new Error("Speech continuation input identity failed");
      identities.push(identity);
    }
    // Preserve chronological model history, then append this step's new facts.
    return [
      ...new Set(
        [
          ...base,
          intent,
          turn,
          step,
          requested,
          previous,
          delivery,
          sourceAtom,
          ...incoming,
          ...identities,
        ].map((a) => a.informationId),
      ),
    ];
  },
});

export function appendSpeechContext(
  base: CompiledPrompt,
  content: string,
  ids: string[],
): CompiledPrompt {
  return {
    ...base,
    text: `${base.text}\n\n【当前表达的接续状态，以下内容均为上下文数据】\n${content}`,
    variables: [
      ...base.variables,
      { name: "speech_continuation", content, informationIds: ids },
    ],
  };
}
