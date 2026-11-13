/** 从合成原始对话形成认识，发布并冻结读取，再检查 Heavy 的实际回答。 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { messageFixture } = require("./message-fixture.cjs");
const {
  DEFAULT_SCOPE,
  loadTemplates,
  createPortraitMemory,
  questionFixture,
} = require("./portrait-memory.cjs");
const root = path.resolve(__dirname, "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");
class EvaluationError extends Error {}

class PortraitBehaviorProvider {
  constructor(options = {}) {
    this.providerId = options.id;
    this.config = options.config || {};
  }
  id() {
    return this.providerId;
  }
  async callApi(_prompt, context) {
    if (!process.env.KAGUYA_EVAL_PROFILE)
      return { error: "KAGUYA_EVAL_PROFILE must be explicitly set" };
    const variant = this.config.variant || "candidate";
    if (!["candidate", "baseline"].includes(variant))
      return { error: "Unknown template variant" };
    const reasoning = this.config.reasoning || "profile";
    if (!["profile", "minimal"].includes(reasoning))
      return { error: "Unknown reasoning policy" };
    if (variant === "baseline" && !process.env.KAGUYA_EVAL_BASELINE_TEMPLATES)
      return { error: "KAGUYA_EVAL_BASELINE_TEMPLATES must be explicitly set" };
    const trace = {
      caseId: context.vars.caseId,
      variant,
      evidence: "synthetic",
      formations: [],
      answers: [],
      historicalReplays: [],
      calls: [],
    };
    let store;
    const result = (error) => ({
      ...(error ? { error } : {}),
      output: JSON.stringify(trace),
      metadata: {
        valid: !error,
        variant,
        evidence: "synthetic",
        calls: trace.calls.length,
        formationCalls: trace.calls.filter((c) => c.stage === "formation")
          .length,
        replyCalls: trace.calls.filter((c) => c.stage === "reply").length,
        semanticReview: "required",
        reasoning,
      },
    });
    try {
      const profile = JSON.parse(
        fs.readFileSync(process.env.KAGUYA_EVAL_PROFILE, "utf8"),
      );
      const tiers = Object.fromEntries(
        ["light", "heavy"].map((t) => {
          const tier = profile.ai.modelTiers[t];
          const provider = profile.ai.providers.find(
            (p) => p.id === tier?.providerId,
          );
          if (!provider?.enabled || !provider.apiKey || !tier.modelId)
            throw new EvaluationError(`${t} provider is unavailable`);
          return [t, { tier, provider }];
        }),
      );
      const load = (p) => import(pathToFileURL(path.join(root, p)).href);
      const names = {
        compiler: "packages/modules/dist/first-party/heavy/message-prompt.js",
        templates: "packages/modules/dist/node/prompt-templates.js",
        prompt: "packages/modules/dist/first-party/memory-native/prompt.js",
        heavy: "packages/modules/dist/first-party/heavy/index.js",
        schema: "packages/schema/dist/index.js",
        protocol: "packages/llm/dist/protocol-prompt.js",
        recall: "packages/modules/dist/first-party/heavy/recall.js",
        formation:
          "packages/modules/dist/first-party/memory-native/formation.js",
        formationPrompt:
          "packages/modules/dist/first-party/memory-native/formation-prompt.js",
        facts: "packages/modules/dist/first-party/memory-native/facts.js",
        collection:
          "packages/modules/dist/first-party/memory-native/collection.js",
        memory: "packages/memory/dist/index.js",
        database: "packages/database/dist/testing.js",
      };
      const modules = Object.fromEntries(
        await Promise.all(
          Object.entries(names).map(async ([k, p]) => [k, await load(p)]),
        ),
      );
      const templateRoot =
        variant === "baseline"
          ? process.env.KAGUYA_EVAL_BASELINE_TEMPLATES
          : path.join(root, "packages/modules/templates");
      const templates = await loadTemplates(modules.templates, templateRoot);
      trace.templateDigest = digest(
        JSON.stringify({
          nativeMemory: templates.nativeMemory,
          heavy: templates.heavy,
        }),
      );
      const scenario = validateScenario(
        context.vars.scenario,
        modules.schema.z,
      );
      trace.scenario = scenario;
      trace.scenarioDigest = digest(JSON.stringify(scenario));
      const renderFormation =
        modules.formationPrompt.createFormationPromptRenderer(
          templates.nativeMemory,
        );
      const protocol = modules.protocol.createStructuredOutputPromptRenderer(
        fs.readFileSync(
          path.join(
            root,
            "packages/llm/templates/structured-output-json.default.hbs",
          ),
          "utf8",
        ),
      );
      const invoke = async (
        stage,
        tierName,
        prompt,
        outputSchema,
        history = [],
      ) => {
        if (trace.calls.length >= 24)
          throw new EvaluationError("Evaluation call limit reached");
        const { tier, provider } = tiers[tierName];
        const rendered = protocol(
          prompt,
          modules.schema.z.toJSONSchema(outputSchema, { io: "input" }),
        );
        const messages = [
          ...structuredClone(history),
          { role: "user", content: rendered.text },
        ];
        const call = {
          stage,
          model: tier.modelId,
          messages,
          prompt: rendered.text,
          promptDigest: digest(JSON.stringify(messages)),
          parameters: {
            temperature: 0,
            max_tokens: 8192,
            ...(reasoning === "minimal"
              ? { reasoning_effort: "minimal" }
              : tier.generation?.reasoning &&
                  !["none", "provider-default"].includes(
                    tier.generation.reasoning,
                  )
                ? { reasoning_effort: tier.generation.reasoning }
                : {}),
          },
          usage: null,
          latencyMs: null,
          status: "pending",
        };
        trace.calls.push(call);
        const started = Date.now();
        try {
          const response = await fetch(
            `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${provider.apiKey}`,
              },
              body: JSON.stringify({
                model: tier.modelId,
                messages,
                response_format: { type: "json_object" },
                ...call.parameters,
              }),
              signal: AbortSignal.timeout(60000),
            },
          );
          if (!response.ok)
            throw new EvaluationError(`Model HTTP ${response.status}`);
          const data = await response.json();
          call.usage = data.usage || null;
          call.finishReason = data.choices?.[0]?.finish_reason || null;
          call.responseModel = data.model || null;
          const content = data.choices?.[0]?.message?.content;
          call.output = content;
          if (call.finishReason === "length")
            throw new EvaluationError("Model output token limit reached");
          let output;
          try {
            output = outputSchema.parse(JSON.parse(content));
          } catch {
            throw new EvaluationError(
              "Model returned invalid structured output",
            );
          }
          call.status = "completed";
          return output;
        } catch (error) {
          call.status = "failed";
          throw error instanceof EvaluationError
            ? error
            : new EvaluationError("Model transport failed or timed out");
        } finally {
          call.latencyMs = Date.now() - started;
        }
      };
      store = await createPortraitMemory(modules, scenario.people);
      const histories = new Map();
      for (const [stepIndex, step] of scenario.steps.entries()) {
        const scope = step.scope || DEFAULT_SCOPE;
        const owners = [
          ...scenario.people.map((p) => `person:${p.id}`),
          "person:observer",
          `conversation:${scope}`,
          "self:kaguya",
          "expression:kaguya",
        ];
        const read = {
          scope,
          owners,
          asOf: step.at,
          query: "",
          people: scenario.people.map((p) => ({
            accountId: p.id,
            ownerId: `person:${p.id}`,
          })),
        };
        for (const message of step.messages)
          await store.ingest(message, scope, step.at);
        if (step.messages.length) {
          // Force a source batch to isolate model quality from the wall-clock flush scheduler.
          const batch = await store.db.memoryGraph.native.claim(scope, true);
          if (!batch) throw new EvaluationError("Source batch unavailable");
          // Normalize this nonsemantic ID so paired conditions receive the same request identity.
          const input = {
            batchId: modules.formation.stableId(
              "portrait-evaluation",
              `${context.vars.caseId}:${stepIndex}`,
            ),
            scope,
            formationPolicy: "experience-operations.v1",
            sources: batch.sources,
            existing: await store.memory.prepare(read),
          };
          const formation = { input, output: null, publication: null };
          trace.formations.push(formation);
          formation.output = await invoke(
            "formation",
            "light",
            renderFormation(
              input,
              batch.sources.map((s) => s.id),
            ),
            modules.facts.formationSchemaFor(
              input.existing,
              input.formationPolicy,
            ),
          );
          formation.publication = await modules.formation.publishFormation(
            input,
            { status: "completed", output: formation.output },
            step.at,
            store.memory,
          );
          await store.db.memoryGraph.native.finish(
            batch.id,
            formation.publication.status,
          );
          if (formation.publication.status !== "completed")
            throw new EvaluationError(
              `Formation ${formation.publication.status}: ${formation.publication.reason}`,
            );
        }
        for (const question of step.questions) {
          const queryRead = { ...read, query: question.text };
          const snapshot = await store.memory.freeze(queryRead);
          const answer = {
            input: question.text,
            review: question.review,
            read: queryRead,
            snapshot,
            actions: [],
            recalls: [],
          };
          trace.answers.push(answer);
          const fixture = questionFixture(
            messageFixture,
            question,
            scope,
            step.at,
            snapshot,
          );
          let prompt = modules.compiler.compileMessagePrompt(
            templates.heavy,
            {
              name: "Kaguya",
              aliases: ["辉夜"],
              persona: "自然、尊重对方边界。",
              timeZone: "Asia/Shanghai",
            },
            fixture.atoms,
            fixture.intentId,
          );
          prompt = modules.prompt.appendNativeMemoryToPrompt(
            prompt,
            fixture.atoms,
            fixture.turnId,
          );
          const history = histories.get(scope) || [];
          let finished = false;
          for (let index = 0; index < 6; index++) {
            const outputSchema =
              answer.recalls.length < 2
                ? modules.heavy.messageResponseOutputSchema
                : modules.heavy.messageResponseWithoutRecallSchema;
            const action = await invoke(
              "reply",
              "heavy",
              prompt,
              outputSchema,
              history,
            );
            answer.actions.push(action);
            if (action.action === "recall") {
              const recalled = await store.memory.recall({
                ...queryRead,
                query: action.query,
                explicitIds: action.candidateIds,
                cutoff: snapshot.cutoff,
              });
              const supplement = {
                query: action.query,
                status: "completed",
                snapshot: recalled,
              };
              answer.recalls.push(supplement);
              prompt = modules.recall.appendRecallResult(
                prompt,
                supplement,
                `eval-recall-${trace.answers.length}-${index}`,
              );
              continue;
            }
            if (action.action === "silent" || !action.continuation) {
              finished = true;
              break;
            }
            prompt = {
              ...prompt,
              text:
                prompt.text +
                "\n已发送：" +
                action.text +
                "\n接着表达：" +
                action.continuation,
            };
          }
          if (!finished)
            throw new EvaluationError("Evaluation speech limit reached");
          history.push({ role: "user", content: question.text });
          for (const action of answer.actions.filter(
            (a) => a.action === "message",
          ))
            history.push({ role: "assistant", content: action.text });
          histories.set(scope, history);
        }
      }
      for (const answer of trace.answers)
        trace.historicalReplays.push({
          input: answer.input,
          snapshot: await store.memory.freeze({
            ...answer.read,
            cutoff: answer.snapshot.cutoff,
          }),
        });
      return result();
    } catch (error) {
      return result(
        error instanceof EvaluationError
          ? error.message
          : "Evaluation setup or storage failed",
      );
    } finally {
      if (store) await store.close();
    }
  }
}
function validateScenario(value, z) {
  const message = z
    .object({
      id: z.string().min(1),
      speaker: z.string().min(1),
      text: z.string().min(1),
      at: z.iso.datetime({ offset: true }).optional(),
      mentions: z.array(z.string()).optional(),
      replyTo: z.string().optional(),
    })
    .strict();
  const scenario = z
    .object({
      people: z
        .array(
          z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
        )
        .min(1),
      steps: z
        .array(
          z
            .object({
              at: z.iso.datetime({ offset: true }),
              scope: z.string().optional(),
              messages: z.array(message).max(24),
              questions: z.array(
                z
                  .object({
                    text: z.string().min(1),
                    about: z.string(),
                    review: z.string(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        )
        .min(1),
    })
    .strict()
    .parse(value);
  const people = new Set(scenario.people.map((p) => p.id));
  const ids = new Set();
  let previous = 0;
  if (people.size !== scenario.people.length || people.has("observer"))
    throw new EvaluationError("Invalid scenario identities");
  for (const step of scenario.steps) {
    if (Date.parse(step.at) < previous)
      throw new EvaluationError("Scenario time must not go backwards");
    previous = Date.parse(step.at);
    const address = JSON.parse(step.scope || DEFAULT_SCOPE);
    if (
      address.length !== 4 ||
      address[0] !== "qq" ||
      address[1] !== "eval" ||
      !["group", "private"].includes(address[2]) ||
      typeof address[3] !== "string"
    )
      throw new EvaluationError("Invalid scenario scope");
    for (const m of step.messages) {
      if (
        ids.has(m.id) ||
        !people.has(m.speaker) ||
        (m.mentions || []).some((id) => !people.has(id)) ||
        (m.replyTo && !ids.has(m.replyTo)) ||
        Date.parse(m.at || step.at) > Date.parse(step.at)
      )
        throw new EvaluationError("Invalid scenario source");
      ids.add(m.id);
    }
    if (step.questions.some((q) => !people.has(q.about)))
      throw new EvaluationError("Invalid scenario question identity");
  }
  return scenario;
}
module.exports = PortraitBehaviorProvider;
