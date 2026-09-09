/**
 * 功能概述：验证 person-fact 模块以非 reply 候选原子调用通用 Model Task，并只把可信完成结果写成业务事实。
 * 主要职责：请求用例检查 capability、activation、tier、source/context 与 Prompt provenance；完成用例检查
 * task/version/definition/source 归属、严格 person/name/fact 输出、候选身份一致性和 registerOnce 去重。
 * 代码库关系：测试仅依赖 modules 侧结构化 ModelTaskCapability 契约与 SDK fixture，不导入 Runtime；
 * `information-kinds.ts` 提供候选和业务 kind，`person-fact-task.ts` 提供模块工厂与任务 schema。
 * 输入输出与副作用：所有原子、能力和注册均在内存中构造，不访问 provider、数据库或凭据；失败与取消
 * 结果只结束请求 handler，不产生 `core.person.fact.extracted`。
 */
import {
  type DeepReadonly,
  freezeInformationAtom,
  informationIdSchema,
  type InformationAtom,
  type InformationReference,
  type JsonObject,
  z,
} from "@kaguya/schema";
import {
  defineInformationKind,
  defineModuleCapability,
  type InformationKindDefinition,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  personFactCandidateInformationKind,
  personFactExtractedInformationKind,
  personFactExtractedPayloadSchema,
} from "../information-kinds.js";
import {
  createPersonFactTaskModule,
  personFactTaskOutputSchema,
  personFactTaskSettingsSchema,
  type ModelTaskCompletedInformationPayload,
  type ModelTaskCapability,
  type ModelTaskRequest,
  type ModelTaskResult,
} from "./index.js";
import * as publicApi from "../../index.js";

const runtimeContextInformationKind = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "Core Runtime Context",
  description: "Information carried by the core.runtime.context kind.",
  payloadSchema: z.object({ requestId: z.string().min(1) }).strict(),
  references: {},
  log: { enabled: false },
});

const modelTaskCapability = defineModuleCapability<ModelTaskCapability>(
  "kaguya:model-task",
  1,
);

const completionOutputSchema = z.union([
  personFactTaskOutputSchema,
  z
    .object({
      personId: z.string(),
      name: z.string(),
      fact: z.string(),
      extra: z.string(),
    })
    .strict(),
  z.object({ personId: z.string(), name: z.string() }).strict(),
]);

const modelTaskCompletedInformationKind = defineInformationKind({
  kind: "core.model.task.completed",
  displayName: "Core Model Task Completed",
  description: "Information carried by the core.model.task.completed kind.",
  payloadSchema: z
    .object({
      taskId: z.string().min(1),
      version: z.string().min(1),
      sourceInformationId: informationIdSchema,
      activation: z
        .object({
          instanceId: z.string().min(1),
          definitionId: z.string().min(1),
        })
        .strict(),
      selectionPolicy: z.object({ tier: z.enum(["light", "heavy"]) }).strict(),
      output: completionOutputSchema,
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:status-of": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: [runtimeContextInformationKind.kind],
    },
  },
  log: { enabled: false },
});

const contextId = informationIdSchema.parse("context-1");

function candidateAtom() {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse("candidate-1"),
    kind: personFactCandidateInformationKind.kind,
    occurredAt: "2026-09-06T00:00:00.000Z",
    source: "module:person-fact-candidate",
    payload: {
      personId: "person-1",
      name: "Ada",
      text: "Ada likes tea.",
    },
    references: [
      { relation: "core:caused-by", informationId: "message-1" },
      { relation: "core:context", informationId: contextId },
    ],
  });
}

function completedAtom(
  payload: Partial<ModelTaskCompletedInformationPayload> = {},
) {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse("completion-1"),
    kind: modelTaskCompletedInformationKind.kind,
    occurredAt: "2026-09-06T00:00:01.000Z",
    source: "runtime:model-task",
    payload: {
      taskId: "core.person.fact.extract",
      version: "2",
      sourceInformationId: "candidate-1",
      activation: {
        instanceId: "person-fact-1",
        definitionId: "demo.person.fact.extract",
      },
      selectionPolicy: { tier: "light" },
      output: { personId: "person-1", name: "Ada", fact: "likes tea" },
      ...payload,
    },
    references: [
      { relation: "core:caused-by", informationId: "requested-1" },
      { relation: "core:status-of", informationId: "requested-1" },
      { relation: "core:context", informationId: contextId },
    ],
  });
}

interface Registration {
  readonly operation: string;
  readonly key: string;
  readonly definition: InformationKindDefinition<string, JsonObject>;
  readonly input: {
    readonly payload: JsonObject;
    readonly references?: readonly InformationReference[];
  };
}

function handlerContext(
  sourceAtom: DeepReadonly<InformationAtom>,
  executor: ModelTaskCapability,
  selectedAtoms: readonly DeepReadonly<InformationAtom>[],
  registrations: Registration[],
): InformationModuleHandlerContext {
  const winners = new Map<string, DeepReadonly<InformationAtom>>();
  return {
    signal: new AbortController().signal,
    report: async () => undefined,
    definitionId: "demo.person.fact.extract",
    instanceId: "person-fact-1",
    sourceAtom,
    now: () => new Date("2026-09-06T00:00:00.000Z"),
    use: (token) => {
      if (!Object.is(token, modelTaskCapability))
        throw new Error("unexpected capability");
      return executor as never;
    },
    select: async () => selectedAtoms,
    registerOnce: async (operation, key, definition, input) => {
      const identity = `${operation}:${key}`;
      const winner = winners.get(identity);
      if (winner !== undefined) return winner as never;
      registrations.push({
        operation,
        key,
        definition: definition as unknown as InformationKindDefinition<
          string,
          JsonObject
        >,
        input: input as Registration["input"],
      });
      const atom = freezeInformationAtom({
        informationId: informationIdSchema.parse(`registered-${winners.size}`),
        kind: definition.kind,
        occurredAt: "2026-09-06T00:00:02.000Z",
        source: "module:person-fact-1",
        payload: input.payload,
        references: [],
      });
      winners.set(identity, atom);
      return atom as never;
    },
    register: async () => {
      throw new Error("person-fact must use registerOnce");
    },
    commitTerminal: async () => {
      throw new Error("person-fact must not commit Model Task terminals");
    },
  };
}

async function createInstance(executor: ModelTaskCapability) {
  const definition = createPersonFactTaskModule({
    modelTaskCapability,
    modelTaskCompletedInformationKind,
  });
  return {
    definition,
    instance: await definition.create(
      {
        instanceId: "person-fact-1",
        activation: {
          instanceId: "person-fact-1",
          definitionId: definition.manifest.definitionId,
        },
        settings: personFactTaskSettingsSchema.parse({ modelTier: "light" }),
      },
      {
        signal: new AbortController().signal,
        now: () => new Date("2026-09-06T00:00:00.000Z"),
        report: async () => undefined,
        use: () => executor as never,
      },
    ),
  };
}

function result(
  status: "completed" | "failed" | "cancelled",
): ModelTaskResult<unknown> {
  if (status === "completed")
    return {
      status,
      output: { personId: "person-1", name: "Ada", fact: "likes tea" },
      requestedInformationId: "requested-1",
      terminalInformationId: "completion-1",
    };
  if (status === "failed")
    return {
      status,
      error: {
        name: "ModelTaskError",
        kind: "non-retryable",
        stage: "provider-request",
        message: "Model task generation failed",
      },
      requestedInformationId: "requested-1",
      terminalInformationId: "failed-1",
    };
  return {
    status,
    reason: "Explicit cancellation requested",
    requestedInformationId: "requested-1",
    terminalInformationId: "cancelled-1",
  };
}

describe("createPersonFactTaskModule", () => {
  it("uses the generic capability with a non-reply candidate and exact prompt provenance", async () => {
    let request: ModelTaskRequest<unknown> | undefined;
    const executor: ModelTaskCapability = {
      async execute(input) {
        request = input;
        return result("completed") as ModelTaskResult<never>;
      },
      cancel: async () => {
        throw new Error("unexpected cancellation");
      },
    };
    const { definition, instance } = await createInstance(executor);
    const candidate = candidateAtom();
    const registrations: Registration[] = [];
    const context = handlerContext(
      candidate,
      executor,
      [candidate],
      registrations,
    );
    const use = vi.spyOn(context, "use");

    await instance.subscriptions[0]!.handle(candidate, context);

    expect(personFactCandidateInformationKind.kind).toBe(
      "core.person.fact.candidate",
    );
    expect(personFactCandidateInformationKind.kind).not.toBe(
      "core.reply.requested",
    );
    expect(definition.manifest.requires).toEqual([
      { id: "kaguya:model-task", apiVersion: 1 },
    ]);
    expect(definition.manifest.consumes.map(({ kind }) => kind)).toEqual([
      "core.person.fact.candidate",
      "core.model.task.completed",
    ]);
    expect(use).toHaveBeenCalledWith(modelTaskCapability);
    expect(request).toMatchObject({
      task: {
        taskId: "core.person.fact.extract",
        version: "2",
        outputMode: "object",
        allowedTiers: ["light", "heavy"],
      },
      sourceInformationId: "candidate-1",
      contextInformationId: "context-1",
      activation: {
        instanceId: "person-fact-1",
        definitionId: "demo.person.fact.extract",
      },
      selectionPolicy: { tier: "light" },
      prompt: {
        kind: "memory",
        fragments: [
          expect.objectContaining({
            id: "candidate-1",
            informationId: "candidate-1",
          }),
        ],
        provenance: [
          expect.objectContaining({
            fragmentId: "candidate-1",
            informationId: "candidate-1",
          }),
        ],
      },
    });
    expect(request!.contextAtoms).toEqual([candidate]);
    expect(
      request!.task.outputSchema.parse({
        personId: "person-1",
        name: "Ada",
        fact: "likes tea",
      }),
    ).toEqual({ personId: "person-1", name: "Ada", fact: "likes tea" });
    for (const output of [
      { personId: "person-1", name: "Ada" },
      { personId: "person-1", name: "Ada", fact: "" },
      { personId: "person-1", name: "Ada", fact: "likes tea", extra: true },
    ])
      expect(request!.task.outputSchema.safeParse(output).success).toBe(false);
    expect(registrations).toEqual([]);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "does not write a domain atom directly from the %s execute result",
    async (status) => {
      const executor: ModelTaskCapability = {
        execute: async () => result(status) as ModelTaskResult<never>,
        cancel: async () => {
          throw new Error("unexpected cancellation");
        },
      };
      const { instance } = await createInstance(executor);
      const candidate = candidateAtom();
      const registrations: Registration[] = [];

      await instance.subscriptions[0]!.handle(
        candidate,
        handlerContext(candidate, executor, [candidate], registrations),
      );

      expect(registrations).toEqual([]);
    },
  );

  it("registers validated completion once with the stable terminal identity", async () => {
    const executor: ModelTaskCapability = {
      execute: async () => result("completed") as ModelTaskResult<never>,
      cancel: async () => {
        throw new Error("unexpected cancellation");
      },
    };
    const { instance } = await createInstance(executor);
    const completed = completedAtom();
    const candidate = candidateAtom();
    const registrations: Registration[] = [];
    const context = handlerContext(
      completed,
      executor,
      [candidate],
      registrations,
    );
    const registerOnce = vi.spyOn(context, "registerOnce");

    await instance.subscriptions[1]!.handle(completed, context);
    await instance.subscriptions[1]!.handle(completed, context);

    expect(registrations).toEqual([
      {
        operation: "kaguya.person-fact.extracted.v1",
        key: "completion-1",
        definition: personFactExtractedInformationKind,
        input: {
          payload: { personId: "person-1", name: "Ada", fact: "likes tea" },
        },
      },
    ]);
    expect(registerOnce).toHaveBeenCalledTimes(2);
    expect(registerOnce).toHaveBeenNthCalledWith(
      1,
      "kaguya.person-fact.extracted.v1",
      "completion-1",
      personFactExtractedInformationKind,
      {
        payload: { personId: "person-1", name: "Ada", fact: "likes tea" },
      },
    );
  });

  it.each([
    [{ taskId: "other.task" }, "task"],
    [{ version: "1" }, "version"],
    [
      {
        activation: {
          instanceId: "other-instance",
          definitionId: "other.definition",
        },
      },
      "definition",
    ],
    [{ selectionPolicy: { tier: "heavy" } }, "selection policy"],
    [{ sourceInformationId: "other-candidate" }, "source provenance"],
  ] as const)(
    "ignores a completion with mismatched $1",
    async (payload, _label) => {
      const executor: ModelTaskCapability = {
        execute: async () => result("completed") as ModelTaskResult<never>,
        cancel: async () => {
          throw new Error("unexpected cancellation");
        },
      };
      const { instance } = await createInstance(executor);
      const completed = completedAtom(payload);
      const registrations: Registration[] = [];

      await instance.subscriptions[1]!.handle(
        completed,
        handlerContext(completed, executor, [candidateAtom()], registrations),
      );

      expect(registrations).toEqual([]);
    },
  );

  it.each([
    {
      personId: "person-1",
      name: "Ada",
      fact: "likes tea",
      extra: "forbidden",
    },
    { personId: "person-1", name: "Ada" },
    { personId: "person-2", name: "Ada", fact: "likes tea" },
    { personId: "person-1", name: "Grace", fact: "likes tea" },
  ])(
    "rejects invalid structural or candidate-inconsistent output",
    async (output) => {
      const executor: ModelTaskCapability = {
        execute: async () => result("completed") as ModelTaskResult<never>,
        cancel: async () => {
          throw new Error("unexpected cancellation");
        },
      };
      const { instance } = await createInstance(executor);
      const completed = completedAtom({ output });
      const registrations: Registration[] = [];

      await expect(
        instance.subscriptions[1]!.handle(
          completed,
          handlerContext(completed, executor, [candidateAtom()], registrations),
        ),
      ).rejects.toThrow();
      expect(registrations).toEqual([]);
    },
  );

  it("exports the task factory, schemas and information kinds from the modules barrel", () => {
    expect(publicApi.createPersonFactTaskModule).toBe(
      createPersonFactTaskModule,
    );
    expect(publicApi.personFactTaskOutputSchema).toBe(
      personFactTaskOutputSchema,
    );
    expect(publicApi.personFactCandidateInformationKind).toBe(
      personFactCandidateInformationKind,
    );
    expect(publicApi.personFactExtractedInformationKind).toBe(
      personFactExtractedInformationKind,
    );
    expect(
      personFactExtractedPayloadSchema.safeParse({
        personId: "person-1",
        name: "Ada",
        fact: "likes tea",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
