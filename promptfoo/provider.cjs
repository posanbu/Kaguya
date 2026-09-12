/**
 * 功能概述：为离线 promptfoo 结构回归连接真实仓库 Prompt 编译器。
 * 主要职责：KaguyaPromptProvider 按 kind 分派；message 通过 compileMessagePrompt 与默认模板编译完整冻结 turn，
 * planner 通过 Heartflow 的真实编译器验证动作边界；route/state/memory 继续使用通用模板渲染器校验结构。参数格式或编译失败直接抛错。
 * 代码库关系：tsx 加载 modules 源码，message-fixture 构造与生产 schema 一致的意图与冻结输入。
 * 输入输出与副作用：输入评测 vars，输出文本及模板变量溯源；只读本地源码和模板，不调用模型或网络。
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PROMPT_KINDS = new Set([
  "route",
  "message",
  "state",
  "memory",
  "planner",
]);
const PROMPT_SOURCE_PATH = path.resolve(
  __dirname,
  "..",
  "packages",
  "modules",
  "src",
  "prompt-template.ts",
);
const PROMPT_SOURCE_LABEL = "packages/modules/src/prompt-template.ts";

class KaguyaPromptProvider {
  constructor(options) {
    this.providerId = options.id;
  }

  id() {
    return this.providerId;
  }

  async callApi(_prompt, context) {
    const vars = requireRecord(context?.vars, "context.vars");
    const kind = requireString(vars.kind, "kind");
    if (!PROMPT_KINDS.has(kind)) {
      throw new Error(`unsupported prompt kind: ${kind}`);
    }

    if (kind === "planner") return compilePlannerEvaluation(vars);
    if (kind === "message") return compileMessageEvaluation(vars);

    const createPromptTemplateRenderer = await loadPromptRenderer();
    const values = buildValues(kind, vars);
    const variables = values.map((value, index) => ({
      name: `value_${index}`,
      content: value.content,
      informationIds: [],
    }));
    const render = createPromptTemplateRenderer({
      kind,
      templateId: `promptfoo.${kind}.v1`,
      main: {
        name: "promptfoo",
        content: values
          .map((value, index) => `[${value.id}]\n{{value_${index}}}`)
          .join("\n\n"),
        allowedVariables: variables.map(({ name }) => name),
      },
    });
    const compiled = render(variables);

    return {
      output: compiled.text,
      metadata: {
        rendererSource: PROMPT_SOURCE_LABEL,
        kind: compiled.kind,
        variables: compiled.variables,
      },
    };
  }
}

async function loadPromptRenderer() {
  const { tsImport } = require("tsx/esm/api");
  const promptModule = await tsImport(
    pathToFileURL(PROMPT_SOURCE_PATH).href,
    pathToFileURL(__filename).href,
  );

  if (typeof promptModule.createPromptTemplateRenderer !== "function") {
    throw new Error(
      "@kaguya/modules does not export createPromptTemplateRenderer",
    );
  }
  return promptModule.createPromptTemplateRenderer;
}

function buildValues(kind, vars) {
  switch (kind) {
    case "route":
      return [
        value("route-persona", requireString(vars.persona, "persona")),
        historyValue("route-history", requireArray(vars.history, "history")),
        memoriesValue("route-memory", requireArray(vars.memories, "memories")),
        value("route-policy", requireString(vars.routePolicy, "routePolicy")),
      ];
    case "state":
      return [
        historyValue("state-history", requireArray(vars.history, "history")),
        value(
          "state-current",
          requireString(vars.currentState, "currentState"),
        ),
        value("state-policy", requireString(vars.statePolicy, "statePolicy")),
      ];
    case "memory":
      return memoryValues(vars);
    default:
      throw new Error(`unsupported prompt kind: ${kind}`);
  }
}

function memoryValues(vars) {
  const window = requireRecord(vars.window, "window");
  const from = parseTimestamp(
    requireString(window.from, "window.from"),
    "window.from",
  );
  const to = parseTimestamp(requireString(window.to, "window.to"), "window.to");
  if (from > to) {
    throw new Error("window.from must not be after window.to");
  }

  const records = requireArray(vars.history, "history")
    .map((value, position) => {
      const record = requireRecord(value, `history[${position}]`);
      return {
        position,
        role: requireString(record.role, `history[${position}].role`),
        content: requireString(record.content, `history[${position}].content`),
        occurredAt: parseTimestamp(
          requireString(record.occurredAt, `history[${position}].occurredAt`),
          `history[${position}].occurredAt`,
        ),
      };
    })
    .filter((record) => record.occurredAt >= from && record.occurredAt <= to)
    .sort(
      (left, right) =>
        left.occurredAt - right.occurredAt || left.position - right.position,
    );

  return [
    value(
      "memory-history",
      records.map((record) => `${record.role}: ${record.content}`).join("\n"),
    ),
    value("memory-policy", requireString(vars.memoryPolicy, "memoryPolicy")),
  ];
}

function historyValue(id, records) {
  return value(
    id,
    records
      .map((value, position) => {
        const record = requireRecord(value, `history[${position}]`);
        return `${requireString(record.role, `history[${position}].role`)}: ${requireString(
          record.content,
          `history[${position}].content`,
        )}`;
      })
      .join("\n"),
  );
}

function memoriesValue(id, records) {
  return value(
    id,
    records
      .map((value, position) => {
        const record = requireRecord(value, `memories[${position}]`);
        return requireString(record.content, `memories[${position}].content`);
      })
      .join("\n"),
  );
}

function value(id, content) {
  return { id, content };
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function parseTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

module.exports = KaguyaPromptProvider;
module.exports.PROMPT_SOURCE_PATH = PROMPT_SOURCE_PATH;

async function compileMessageEvaluation(vars) {
  const { tsImport } = require("tsx/esm/api");
  const source =
    "packages/modules/src/first-party/message-composer/message-prompt.ts";
  const compiler = await tsImport(
    pathToFileURL(path.resolve(__dirname, "..", source)).href,
    pathToFileURL(__filename).href,
  );
  const loader = await tsImport(
    pathToFileURL(
      path.resolve(
        __dirname,
        "../packages/modules/src/node/prompt-templates.ts",
      ),
    ).href,
    pathToFileURL(__filename).href,
  );
  const { messageFixture } = require("./message-fixture.cjs");
  const { atoms, intentId } = messageFixture(
    requireArray(requireRecord(vars.turn, "turn").inputs, "turn.inputs"),
  );
  const prompt = compiler.compileMessagePrompt(
    loader.loadFirstPartyPromptTemplates().messageComposer,
    {
      name: "Kaguya",
      aliases: ["辉夜"],
      persona: requireString(vars.persona, "persona"),
    },
    atoms,
    intentId,
  );
  return {
    output: prompt.text,
    metadata: {
      rendererSource: source,
      kind: prompt.kind,
      variables: prompt.variables,
    },
  };
}

async function compilePlannerEvaluation(vars) {
  const { tsImport } = require("tsx/esm/api");
  const source = "packages/modules/src/first-party/heartflow/planner.ts";
  const compiler = await tsImport(
    pathToFileURL(path.resolve(__dirname, "..", source)).href,
    pathToFileURL(__filename).href,
  );
  const fixtureModule = await tsImport(
    pathToFileURL(
      path.resolve(
        __dirname,
        "../packages/modules/src/first-party/message-composer/test-fixtures.ts",
      ),
    ).href,
    pathToFileURL(__filename).href,
  );
  const { atoms } = fixtureModule.fixture(vars.turn.inputs);
  const turn = atoms.find(
    (atom) => atom.kind === "agent.turn.context.completed",
  );
  const prompt = compiler.compilePlannerPrompt(
    { name: "Kaguya", aliases: ["辉夜"], persona: vars.persona },
    atoms,
    turn,
  );
  return {
    output: prompt.text,
    metadata: {
      rendererSource: source,
      kind: prompt.kind,
      variables: prompt.variables,
    },
  };
}
