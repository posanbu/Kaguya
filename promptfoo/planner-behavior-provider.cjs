/**
 * 功能概述：将脱敏冻结变量接回真实 Prompt 渲染器，调用显式配置的模型验证 Planner 行为。
 * 主要职责：PlannerBehaviorProvider 读取指定模板和评测 profile，生成 JSON 模型请求；
 * callApi 使用生产结构化协议及本轮 schema 校验动作；KAGUYA_EVAL_TASK_VERSION=1 可复现通用旧契约。
 * 代码库关系：供 planner-behavior.yaml 使用；复用 modules 的模板声明及 schema，
 * fixture.variables 对应账本 core.model.task.requested.prompt.variables，不重做上下文召回。
 * 旧快照没有 context_bootstrap 时显式标记 unknown；不从脱敏历史补造身份或空库状态，已有字段原样保留。
 * 输入输出与副作用：只读模板/profile，向 profile light 模型发送评测请求；不写账本、不发送群消息。
 * 必须显式设置 KAGUYA_EVAL_PROFILE；密钥不进入配置、输出或异常正文，网络故障计为评测错误。
 */
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root =
  process.env.KAGUYA_EVAL_SOURCE_ROOT || path.resolve(__dirname, "..");
let modules;
async function loadModules() {
  return (modules ??= Promise.all([
    import(
      pathToFileURL(path.join(root, "packages/modules/dist/prompt-template.js"))
    ),
    import(
      pathToFileURL(
        path.join(root, "packages/modules/dist/prompt-declarations.js"),
      )
    ),
    import(
      pathToFileURL(
        path.join(
          root,
          "packages/modules/dist/first-party/heartflow/planner.js",
        ),
      )
    ),
    import(pathToFileURL(path.join(root, "packages/schema/dist/index.js"))),
    import(
      pathToFileURL(path.join(root, "packages/llm/dist/protocol-prompt.js"))
    ),
  ]));
}
class PlannerBehaviorProvider {
  constructor(options) {
    this.config = options.config || {};
    this.providerId = options.id;
  }
  id() {
    return this.providerId;
  }
  async callApi(_prompt, context) {
    const profilePath = process.env.KAGUYA_EVAL_PROFILE;
    if (!profilePath)
      return { error: "KAGUYA_EVAL_PROFILE must be explicitly set" };
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    const tier = profile.ai.modelTiers.light;
    const provider = profile.ai.providers.find((p) => p.id === tier.providerId);
    if (!provider?.enabled || !provider.apiKey)
      return { error: "Light provider is unavailable" };
    const [renderer, declarations, planner, schema, protocol] =
      await loadModules();
    const templatePath =
      process.env.KAGUYA_EVAL_TEMPLATE ||
      path.join(
        root,
        "packages/modules/templates/heartflow.planner.default.hbs",
      );
    const fixtureVariables = {
      context_bootstrap: JSON.stringify({
        mode: "unknown",
        reason: "legacy-snapshot",
      }),
      bootstrap_policy: fs.readFileSync(
        path.join(
          root,
          "packages/modules/templates/heartflow.bootstrap-policy.default.hbs",
        ),
        "utf8",
      ),
      bootstrap: JSON.stringify({
        version: 1,
        mode: "legacy-unknown",
        memory: { state: "unknown", selectedCount: 0 },
        conversation: { state: "unknown" },
        participants: [],
      }),
      ...context.vars.fixture.variables,
    };
    const variables = Object.entries(fixtureVariables).map(
      ([name, content]) => ({ name, content, informationIds: [] }),
    );
    const turn = JSON.parse(context.vars.fixture.variables.turn);
    const taskVersion = process.env.KAGUYA_EVAL_TASK_VERSION || "2";
    const actionSchema =
      taskVersion === "1"
        ? planner.plannerActionSchema
        : planner.plannerActionSchemaForTurn(turn);
    const rendered = renderer.createPromptTemplateRenderer({
      kind: "route",
      templateId: "promptfoo.planner.behavior",
      main: {
        ...declarations.plannerTemplateDeclaration,
        content: fs.readFileSync(templatePath, "utf8"),
      },
    })(variables);
    const compiled = protocol.createStructuredOutputPromptRenderer(
      fs.readFileSync(
        path.join(
          root,
          "packages/llm/templates/structured-output-json.default.hbs",
        ),
        "utf8",
      ),
    )(rendered, schema.z.toJSONSchema(actionSchema, { io: "input" }));
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
            messages: [{ role: "user", content: compiled.text }],
            response_format: { type: "json_object" },
            temperature: 0,
          }),
          signal: AbortSignal.timeout(120000),
        },
      );
    } catch {
      return { error: "Model transport failed or timed out" };
    }
    if (!response.ok) return { error: `Model HTTP ${response.status}` };
    let data;
    try {
      data = await response.json();
    } catch {
      return { error: "Model returned invalid HTTP JSON" };
    }
    const output = data.choices?.[0]?.message?.content;
    if (typeof output !== "string") return { error: "Model returned no text" };
    let valid = false;
    try {
      const decision = actionSchema.parse(JSON.parse(output));
      valid =
        decision.action === "message"
          ? decision.composition.focusInputIndexes.every(
              (i) => i < turn.inputs.length,
            )
          : decision.action !== "wait" || turn.attempt < turn.totalWaitBudget;
    } catch {
      /* 不修复模型输出，保留非法 JSON 或 schema 失败。 */
    }
    return {
      output,
      metadata: {
        valid,
        taskVersion,
        model: tier.modelId,
        promptDigest: createHash("sha256").update(compiled.text).digest("hex"),
      },
      tokenUsage: {
        total: data.usage?.total_tokens || 0,
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
      },
    };
  }
}
module.exports = PlannerBehaviorProvider;
