/**
 * 功能概述：实现最小 person-fact Model Task 垂直切片，把非 reply 候选编译为可追溯 Prompt，
 * 并仅从属于本模块的 completed 终态派生 `core.person.fact.extracted` 业务原子。
 * 主要职责：`personFactTaskOutputSchema` 定义模型任务的严格 person/name/fact 结构；
 * `createPersonFactTaskModule` 校验并声明宿主注入的 capability/completed definition，候选订阅通过
 * `context.use` 执行 `core.person.fact.extract` v1，完成订阅核对 task/version/definition/tier/source，
 * 再验证输出与候选人物身份一致并使用稳定 terminal ID 调用 registerOnce。
 * 代码库关系：仅依赖 modules 侧 `llm-reply.ts` 的结构化 Model Task contract、SDK、PromptCompiler
 * 和本包 information kinds；不导入 Runtime、provider、Core、数据库或凭据。Host 负责 selector 授权、
 * completed→requested→candidate 因果遍历，以及为业务注册补齐 caused-by/context 引用。
 * 输入输出与副作用：候选 handler 只提交通用任务请求，不直接写业务结果；failed/cancelled 没有对应
 * 业务订阅。completed 输出先经任务 schema 做结构校验，再按候选 personId/name 做业务校验；非法或
 * 伪造终态不会注册，重复 completed 投递由 registerOnce 去重。
 */
import {
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
  type PromptFragment,
  z,
} from "@kaguya/schema";
import {
  defineInformationModule,
  defineModuleDiagnostic,
  defineInformationSelector,
  type InformationKindDefinition,
  type InformationPromptRendererDefinition,
  type ModuleCapability,
  onInformation,
} from "@kaguya/sdk";
import { PromptCompiler } from "@kaguya/prompt";

import {
  personFactCandidateInformationKind,
  personFactCandidateInformationPayloadSchema,
  personFactExtractedInformationKind,
  personFactExtractedPayloadSchema,
  type PersonFactCandidateInformationPayload,
  type PersonFactExtractedPayload,
} from "./information-kinds.js";
import {
  modelTierSchema,
  type ModelTaskCapability,
  type ModelTaskCompletedInformationPayload,
  type ModelTaskRequest,
  type ModelTaskResult,
  type ModelTier,
} from "./llm-reply.js";

export type {
  ModelTaskCapability,
  ModelTaskCompletedInformationPayload,
  ModelTaskRequest,
  ModelTaskResult,
};

const nonBlankString = z.string().trim().min(1);

export const personFactTaskOutputSchema = z
  .object({
    personId: nonBlankString,
    name: nonBlankString,
    fact: nonBlankString,
  })
  .strict();
export type PersonFactTaskOutput = z.infer<typeof personFactTaskOutputSchema>;

export const personFactTaskSettingsSchema = z
  .object({ modelTier: modelTierSchema })
  .strict();
export type PersonFactTaskSettings = z.infer<
  typeof personFactTaskSettingsSchema
>;

export const personFactModelDispatchingDiagnostic = defineModuleDiagnostic({
  event: "person-fact.model.dispatching",
  message: "Person-fact model task dispatching",
  level: "info",
  payloadSchema: z
    .object({
      taskId: z.literal("core.person.fact.extract"),
      taskVersion: z.literal("1"),
      tier: modelTierSchema,
      promptCharacters: z.number().int().nonnegative(),
      promptFragmentCount: z.number().int().nonnegative(),
    })
    .strict(),
  project: (payload) => ({ ...payload }),
});

export interface CreatePersonFactTaskModuleOptions<
  P extends ModelTaskCompletedInformationPayload =
    ModelTaskCompletedInformationPayload,
> {
  readonly modelTaskCapability: ModuleCapability<ModelTaskCapability>;
  readonly modelTaskCompletedInformationKind: InformationKindDefinition<
    "core.model.task.completed",
    P
  >;
  readonly promptCompiler?: PromptCompiler;
}

export const currentPersonFactCandidateSelector = defineInformationSelector({
  selectorId: "core.person.fact.current-candidate",
  select: ({ sourceAtom }) => [sourceAtom.informationId],
});

export const personFactCandidatePromptRenderer: InformationPromptRendererDefinition =
  Object.freeze({
    rendererId: "kaguya.person-fact.candidate",
    kinds: [personFactCandidateInformationKind],
    render: (atom: DeepReadonly<InformationAtom>) => {
      const candidate = personFactCandidateInformationPayloadSchema.parse(
        atom.payload,
      );
      return [
        "Extract one durable person fact from this candidate.",
        `personId: ${candidate.personId}`,
        `name: ${candidate.name}`,
        `candidate: ${candidate.text}`,
      ].join("\n");
    },
  });

export function createPersonFactTaskModule<
  P extends ModelTaskCompletedInformationPayload,
>(dependencies: CreatePersonFactTaskModuleOptions<P>) {
  const { modelTaskCapability } = dependencies;
  if (
    modelTaskCapability.id !== "kaguya:model-task" ||
    modelTaskCapability.apiVersion !== 1
  )
    throw new Error("Invalid model task capability");
  const completedInformationKind =
    dependencies.modelTaskCompletedInformationKind;
  const promptCompiler = dependencies.promptCompiler ?? new PromptCompiler();

  return defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      selectors: [
        currentPersonFactCandidateSelector,
        completedPersonFactCandidateSelector,
      ],
      promptRenderers: [personFactCandidatePromptRenderer],
      requires: [modelTaskCapability],
      provides: [],
      definitionId: "demo.person.fact.extract",
      displayName: "Person fact extractor",
      settingsSchema: personFactTaskSettingsSchema,
      consumes: [personFactCandidateInformationKind, completedInformationKind],
      produces: [personFactExtractedInformationKind],
      diagnostics: [personFactModelDispatchingDiagnostic],
    },
    create: ({ settings, activation }) => ({
      provisions: [],
      describeStartup: () => ({
        summary: "Person-fact extraction pipeline ready",
        fields: {
          modelTier: settings.modelTier,
          taskId: "core.person.fact.extract",
          taskVersion: "1",
        },
      }),
      subscriptions: [
        onInformation(
          personFactCandidateInformationKind,
          {
            subscriptionId: "kaguya.person-fact.candidate",
            delivery: "durable",
          },
          async (candidate, context) => {
            const contextAtoms = await context.select(
              currentPersonFactCandidateSelector,
            );
            const persistedCandidate = requireSelectedCandidate(
              contextAtoms,
              candidate.informationId,
            );
            const contextInformationId = requireContextId(persistedCandidate);
            const prompt = compilePersonFactPrompt(
              promptCompiler,
              contextAtoms,
              persistedCandidate.informationId,
            );
            await context.report(personFactModelDispatchingDiagnostic, {
              taskId: "core.person.fact.extract",
              taskVersion: "1",
              tier: settings.modelTier,
              promptCharacters: Array.from(prompt.text).length,
              promptFragmentCount: prompt.fragments.length,
            });
            await context.use(modelTaskCapability).execute({
              task: {
                taskId: "core.person.fact.extract",
                version: "1",
                outputSchema: personFactTaskOutputSchema,
                allowedTiers: ["light", "heavy"],
              },
              sourceInformationId: persistedCandidate.informationId,
              contextInformationId,
              activation,
              selectionPolicy: { tier: settings.modelTier },
              prompt,
              contextAtoms,
            });
          },
        ),
        onInformation(
          completedInformationKind,
          {
            subscriptionId: "kaguya.person-fact.model-task-completed",
            delivery: "durable",
          },
          async (completed, context) => {
            if (
              !isOwnedCompletion(
                completed.payload,
                activation.definitionId,
                settings.modelTier,
              )
            )
              return;
            const candidates = await context.select(
              completedPersonFactCandidateSelector,
            );
            if (
              !candidates.some(
                (candidate) =>
                  candidate.informationId ===
                  completed.payload.sourceInformationId,
              )
            )
              return;
            const candidate = requireSelectedCandidate(
              candidates,
              completed.payload.sourceInformationId,
            );
            const output = personFactTaskOutputSchema.parse(
              completed.payload.output,
            );
            const domainPayload = validateDomainFact(candidate.payload, output);
            await context.registerOnce(
              "kaguya.person-fact.extracted.v1",
              completed.informationId,
              personFactExtractedInformationKind,
              { payload: domainPayload },
            );
          },
        ),
      ],
    }),
  });
}

const completedPersonFactCandidateSelector = defineInformationSelector({
  selectorId: "kaguya.person-fact.completed-source",
  select: async ({ sourceAtom, ledger }) => {
    const payload = z
      .object({ sourceInformationId: nonBlankString })
      .parse(sourceAtom.payload);
    const requested = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:caused-by",
      direction: "outgoing",
      limit: 1,
    });
    if (requested[0]?.kind !== "core.model.task.requested")
      throw new Error("Model task completion must reference its request");
    const sources = await ledger.related({
      from: [requested[0].informationId],
      relation: "core:caused-by",
      direction: "outgoing",
      limit: 1,
    });
    const candidate = sources[0];
    if (
      candidate?.kind !== personFactCandidateInformationKind.kind ||
      candidate.informationId !== payload.sourceInformationId
    )
      throw new Error(
        "Model task completion source must match its person-fact candidate cause",
      );
    return [candidate.informationId];
  },
});

function compilePersonFactPrompt(
  compiler: PromptCompiler,
  atoms: readonly DeepReadonly<InformationAtom>[],
  sourceInformationId: InformationId,
): CompiledPrompt {
  const candidate = requireSelectedCandidate(atoms, sourceInformationId);
  const fragment: PromptFragment = {
    id: candidate.informationId,
    informationId: candidate.informationId,
    source: "memory",
    priority: 20,
    content: personFactCandidatePromptRenderer.render(candidate),
    metadata: { scope: "memory" },
  };
  return compiler.compile("memory", [fragment]);
}

function requireSelectedCandidate(
  atoms: readonly DeepReadonly<InformationAtom>[],
  informationId: string,
): DeepReadonly<
  InformationAtom<
    "core.person.fact.candidate",
    PersonFactCandidateInformationPayload
  >
> {
  const candidate = atoms.find((atom) => atom.informationId === informationId);
  if (candidate === undefined)
    throw new Error("Person-fact selection must include the candidate source");
  if (candidate.kind !== personFactCandidateInformationKind.kind)
    throw new Error(
      `Selected person-fact candidate has unexpected kind: ${candidate.kind}`,
    );
  personFactCandidateInformationPayloadSchema.parse(candidate.payload);
  return candidate as DeepReadonly<
    InformationAtom<
      "core.person.fact.candidate",
      PersonFactCandidateInformationPayload
    >
  >;
}

function requireContextId(
  candidate: DeepReadonly<InformationAtom>,
): InformationId {
  const contexts = candidate.references.filter(
    ({ relation }) => relation === "core:context",
  );
  if (contexts.length !== 1)
    throw new Error("Person-fact candidate must have one context");
  return contexts[0]!.informationId;
}

function isOwnedCompletion(
  payload: DeepReadonly<ModelTaskCompletedInformationPayload>,
  definitionId: string,
  modelTier: ModelTier,
): boolean {
  return (
    payload.taskId === "core.person.fact.extract" &&
    payload.version === "1" &&
    payload.activation.definitionId === definitionId &&
    payload.selectionPolicy.tier === modelTier
  );
}

function validateDomainFact(
  candidate: DeepReadonly<PersonFactCandidateInformationPayload>,
  output: PersonFactTaskOutput,
): PersonFactExtractedPayload {
  if (output.personId !== candidate.personId || output.name !== candidate.name)
    throw new Error("Extracted person identity must match its candidate");
  return personFactExtractedPayloadSchema.parse(output);
}
