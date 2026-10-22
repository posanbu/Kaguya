/** Synthetic, same-model portrait ablation. No ledger writes or platform delivery. */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const { messageFixture } = require("./message-fixture.cjs");
class PortraitBehaviorProvider {
  constructor(options) {
    this.providerId = options.id;
    this.config = options.config || {};
  }
  id() {
    return this.providerId;
  }
  async callApi(_prompt, context) {
    if (!process.env.KAGUYA_EVAL_PROFILE)
      return { error: "KAGUYA_EVAL_PROFILE must be explicitly set" };
    const profile = JSON.parse(
      fs.readFileSync(process.env.KAGUYA_EVAL_PROFILE, "utf8"),
    );
    const tier = profile.ai.modelTiers.heavy;
    const provider = profile.ai.providers.find((p) => p.id === tier.providerId);
    if (!provider?.enabled || !provider.apiKey)
      return { error: "Heavy provider is unavailable" };
    const load = (p) => import(pathToFileURL(path.join(root, p)).href);
    const [compiler, templates, memory, heavy, schema, protocol, recall] =
      await Promise.all([
        load("packages/modules/dist/first-party/heavy/message-prompt.js"),
        load("packages/modules/dist/node/prompt-templates.js"),
        load("packages/modules/dist/first-party/memory-native/prompt.js"),
        load("packages/modules/dist/first-party/heavy/index.js"),
        load("packages/schema/dist/index.js"),
        load("packages/llm/dist/protocol-prompt.js"),
        load("packages/modules/dist/first-party/heavy/recall.js"),
      ]);
    const scenario = context.vars.scenario;
    const history = [],
      transcript = [],
      digests = [];
    let calls = 0;
    const at = "2026-09-09T00:00:03.000Z";
    const owner = "person:eval-person";
    const scope = JSON.stringify(["qq", "eval", "group", "group-1"]);
    for (const [turnIndex, turn] of scenario.turns.entries()) {
      const { atoms, intentId } = messageFixture([turn.text]);
      const turnAtom = atoms.find(
        (a) => a.kind === "agent.router.turn.context.completed",
      );
      turnAtom.payload.inputs[0].identity.personInformationId = "eval-person";
      const makeNode = (content, index, level) =>
        schema.nativeMemoryNodeSchema.parse({
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          content,
          metadata: {
            system: "native-v1",
            kind: "person",
            ownerId: owner,
            scope,
            level,
            revision: 1,
            occurredAt: at,
            sourceIds: [`synthetic-${index}`],
          },
        });
      const details =
        this.config.background === false ? [] : turn.background || [];
      const snapshot = schema.nativeMemorySnapshotSchema.parse({
        version: 1,
        status: "enabled",
        frozenAt: at,
        scope,
        owners: [owner],
        fixed: turn.relationship ? [makeNode(turn.relationship, 0, 0)] : [],
        recalled: details.map((text, i) => ({
          node: makeNode(text, i + 1, 1),
          traces: [],
          truncated: false,
        })),
        degraded: [],
        budget: {
          dynamicCharacters: details.join("").length,
          omittedNodeIds: [],
        },
      });
      let prompt = compiler.compileMessagePrompt(
        templates.loadFirstPartyPromptTemplates().heavy,
        {
          name: "Kaguya",
          aliases: ["辉夜"],
          persona: "自然、尊重对方边界。",
          timeZone: "Asia/Shanghai",
        },
        atoms,
        intentId,
      );
      prompt = memory.appendNativeMemoryToPrompt(
        prompt,
        [
          ...atoms,
          {
            informationId: "frozen",
            kind: "agent.situation.frozen",
            payload: {
              turnInformationId: turnAtom.informationId,
              frame: { memory: snapshot },
            },
          },
        ],
        turnAtom.informationId,
      );
      const actions = [];
      let finished = false;
      // Bound evaluation cost. This is not the production speech scheduler.
      for (let step = 0; step < 6; step++) {
        const outputSchema =
          recall.recallHistory(prompt).length < 2
            ? heavy.messageResponseOutputSchema
            : heavy.messageResponseWithoutRecallSchema;
        const rendered = protocol.createStructuredOutputPromptRenderer(
          fs.readFileSync(
            path.join(
              root,
              "packages/llm/templates/structured-output-json.default.hbs",
            ),
            "utf8",
          ),
        )(prompt, schema.z.toJSONSchema(outputSchema, { io: "input" }));
        digests.push(createHash("sha256").update(rendered.text).digest("hex"));
        let response;
        try {
          response = await fetch(
            `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${provider.apiKey}`,
              },
              body: JSON.stringify({
                model: tier.modelId,
                messages: [
                  ...history,
                  { role: "user", content: rendered.text },
                ],
                response_format: { type: "json_object" },
                temperature: 0,
                max_tokens: 2048,
              }),
              signal: AbortSignal.timeout(60000),
            },
          );
        } catch {
          return { error: "Model transport failed or timed out" };
        }
        calls++;
        if (!response.ok) return { error: `Model HTTP ${response.status}` };
        let action;
        try {
          const data = await response.json();
          action = outputSchema.parse(
            JSON.parse(data.choices[0].message.content),
          );
        } catch {
          return { error: "Model returned invalid structured output" };
        }
        actions.push(action);
        if (action.action === "recall") {
          // Frozen synthetic evidence, not a claim about live retrieval quality.
          prompt = recall.appendRecallResult(
            prompt,
            { query: action.query, status: "completed", snapshot },
            `eval-recall-${turnIndex}-${step}`,
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
        if (step === 5) return { error: "Evaluation speech limit reached" };
      }
      if (!finished) return { error: "Evaluation speech limit reached" };
      transcript.push({ input: turn.text, actions, review: turn.review });
      history.push({ role: "user", content: turn.text });
      for (const a of actions.filter((a) => a.action === "message"))
        history.push({ role: "assistant", content: a.text });
    }
    return {
      output: JSON.stringify(transcript),
      metadata: {
        valid: true,
        model: tier.modelId,
        background: this.config.background !== false,
        calls,
        promptDigests: digests,
        evidence: "synthetic",
      },
    };
  }
}
module.exports = PortraitBehaviorProvider;
