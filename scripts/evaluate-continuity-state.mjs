import { captureModelAttempts } from "./continuity-evaluation-model.mjs";
/** 同一证据下的主观状态选择评测。实际运行生产选择任务，不执行候选工具或发送消息。 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureManagedPostgres } from "../apps/server/dist/postgres-development.js";
import { createRuntimeModelSelectionResolver } from "../apps/server/dist/server.js";
import { userConfigProfileSchema } from "../packages/config/dist/index.js";
import { createPostgresTestingDatabase } from "../packages/database/dist/testing.js";
import {
  createMessageCatalog,
  createMessageComposition,
} from "../packages/composition/dist/index.js";
import { createFirstPartyModuleConfigDefaults } from "../packages/modules/dist/index.js";
import { continuityChoiceFor } from "../packages/modules/dist/first-party/continuity/index.js";
import { createPromptTemplateRenderer } from "../packages/modules/dist/prompt-template.js";
import { continuityTemplateDeclaration } from "../packages/modules/dist/prompt-declarations.js";
import { loadFirstPartyPromptTemplates } from "../packages/modules/dist/node/prompt-templates.js";
import {
  continuityKinds,
  continuityCapability,
  defineInformationModule,
} from "../packages/sdk/dist/index.js";
import { createNativeMemoryAccess } from "../packages/memory/dist/index.js";
import {
  KaguyaRuntime,
  modelTaskCapability,
} from "../packages/runtime/dist/index.js";
import { z } from "../packages/schema/dist/index.js";
const profilePath = process.env.KAGUYA_CONTINUITY_EVAL_PROFILE,
  output = process.env.KAGUYA_CONTINUITY_EVAL_OUTPUT;
if (!profilePath || !output)
  throw new Error("Explicit evaluation Profile and output required");
await mkdir(output, { recursive: true, mode: 0o700 });
const profile = userConfigProfileSchema.parse(
  JSON.parse(await readFile(profilePath, "utf8")),
);
const templates = loadFirstPartyPromptTemplates();
const render = createPromptTemplateRenderer({
  kind: "state",
  templateId: "agent.continuity.v1",
  main: { ...continuityTemplateDeclaration, content: templates.continuity },
});
const managed = await ensureManagedPostgres({}),
  db = await createPostgresTestingDatabase(managed.databaseUrl);
const scope =
  '["kaguya","internal","web","00000000-0000-4000-8000-000000000001"]';
const requestedState = process.argv
  .find((arg) => arg.startsWith("--state="))
  ?.slice(8);
if (
  requestedState &&
  !["focused", "available", "solitude", "budget-exhausted"].includes(
    requestedState,
  )
)
  throw new Error("invalid-evaluation-state");
const attempts = [];
const cases = [],
  activation = {
    instanceId: "continuity.evaluation",
    definitionId: "agent.continuity",
  };
let runtime;
try {
  await db.prepareSchema();
  await db.continuity.configure({
    agentId: "kaguya",
    operationId: "setup",
    expectedRevision: 0,
    policy: {
      version: "evaluation.v1",
      enabled: true,
      timeZone: profile.identity.timeZone,
      dailyModelCalls: 24,
      subjectiveTtlMs: 1800000,
    },
    basis: [],
  });
  const initial = await db.continuity.read("kaguya", scope);
  await db.continuity.create({
    agentId: "kaguya",
    operationId: "same-evidence",
    expectedRevision: initial.revision,
    activity: {
      id: "reading",
      scope,
      kind: "plan",
      title: "继续阅读公开协议",
      goal: "读取 RFC 9110 的请求语义并保存笔记",
      nextStep: "从请求语义继续",
      sources: [initial.policyInformationId],
    },
  });
  const fixture = defineInformationModule({
    manifest: {
      definitionId: "agent.continuity",
      displayName: "选择行为验收夹具",
      category: "agent",
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      summary: "相同证据，不同主观状态",
      description: "仅评测选择，无工具与投递。",
      settingsSchema: z.object({}).strict(),
      consumes: [],
      produces: [...continuityKinds],
      provides: [],
      selectors: [],
      promptTemplates: [continuityTemplateDeclaration],
      promptRenderers: [],
      requires: [modelTaskCapability, continuityCapability],
    },
    create: () => ({
      provisions: [],
      subscriptions: [],
      ready: async (context) => {
        for (const social of [
          "focused",
          "available",
          "solitude",
          "budget-exhausted",
        ].filter((state) => !requestedState || state === requestedState)) {
          let view = await context
            .use(continuityCapability)
            .read("kaguya", scope);
          if (social === "budget-exhausted") {
            await context.use(continuityCapability).configure({
              agentId: "kaguya",
              operationId: "empty-budget",
              expectedRevision: view.revision,
              policy: {
                ...view.policy,
                dailyModelCalls: 0,
                version: "evaluation.exhausted.v1",
              },
              basis: [view.policyInformationId],
            });
            view = await context
              .use(continuityCapability)
              .read("kaguya", scope);
          }
          await context.use(continuityCapability).evaluate({
            agentId: "kaguya",
            operationId: `state:${social}`,
            expectedRevision: view.revision,
            scope,
            subjective: {
              attention: ["reading"],
              interests: [{ topic: "公开协议", reason: "想理解缓存" }],
              appraisal: "合成状态夹具，事实证据相同",
              social: social === "budget-exhausted" ? "focused" : social,
            },
            basis: [initial.policyInformationId],
          });
          const memory = await createNativeMemoryAccess({
            enabled: true,
            store: db.memoryGraph.native,
          }).freeze({
            scope,
            owners: ["self:kaguya"],
            query: "",
            asOf: context.now().toISOString(),
          });
          const frozen = await context.use(continuityCapability).freeze({
            agentId: "kaguya",
            operationId: `choice:${social}`,
            scope,
            basis: [initial.policyInformationId],
            memory,
          });
          const result = await context.use(modelTaskCapability).execute({
            task: {
              taskId: "agent.continuity.choose",
              outputMode: "object",
              outputSchema: continuityChoiceFor(frozen.view),
              allowedTiers: ["light"],
            },
            activation,
            sourceInformationId: frozen.informationId,
            contextInformationId: frozen.view.contextInformationId,
            selectionPolicy: { tier: "light" },
            contextAtoms: [frozen.atom],
            prompt: render([
              { name: "phase", content: "选择", informationIds: [] },
              {
                name: "context",
                content: JSON.stringify(frozen.atom.payload),
                informationIds: [frozen.informationId],
              },
            ]),
          });
          cases.push({
            social,
            fixture: "same-evidence-subjective-only",
            result,
          });
          process.stdout.write(`${social}: ${result.status}\n`);
        }
      },
    }),
  });
  const original = createMessageCatalog(
    profile.identity,
    templates,
    false,
    true,
  );
  const catalog = {
    ...original,
    definitions: [
      ...original.definitions.filter(
        (d) => d.manifest.definitionId !== "agent.continuity",
      ),
      fixture,
    ],
  };
  const moduleConfigs = createFirstPartyModuleConfigDefaults("test").map(
    (c) => ({
      ...c,
      instanceId:
        c.definitionId === "agent.continuity"
          ? activation.instanceId
          : c.instanceId,
      enabled: ["agent.continuity", "memory.native"].includes(c.definitionId),
    }),
  );
  runtime = new KaguyaRuntime({
    database: db,
    ...createMessageComposition(
      captureModelAttempts(
        createRuntimeModelSelectionResolver(profile),
        attempts,
      ),
      {
        moduleConfigs,
        memoryEnabled: true,
        agentIdentity: profile.identity,
        catalog,
      },
    ),
  });
  await runtime.start();
  await runtime.close();
  runtime = undefined;
  const atoms = await db.information.find({
    occurredAfter: "2020-01-01T00:00:00Z",
    registrationOrder: true,
    order: "asc",
    limit: 1000,
  });
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        version: 1,
        at: new Date().toISOString(),
        cases,
        attempts,
        atoms,
        parameters: profile.ai.modelTiers.light,
        cost: { status: "unavailable", reason: "pricing-not-configured" },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
} finally {
  await runtime?.close();
  await db.close();
}
