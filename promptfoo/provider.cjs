const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PROMPT_KINDS = new Set(["route", "reply", "state", "memory"]);
const PROMPT_SOURCE_PATH = path.resolve(
  __dirname,
  "..",
  "packages",
  "prompt",
  "src",
  "index.ts",
);
const PROMPT_SOURCE_LABEL = "packages/prompt/src/index.ts";

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

    const PromptCompiler = await loadPromptCompiler();
    const compiled = new PromptCompiler().compile(
      kind,
      buildFragments(kind, vars),
    );

    return {
      output: compiled.text,
      metadata: {
        compilerSource: PROMPT_SOURCE_LABEL,
        kind: compiled.kind,
        provenance: compiled.provenance,
      },
    };
  }
}

async function loadPromptCompiler() {
  const { tsImport } = require("tsx/esm/api");
  const promptModule = await tsImport(
    pathToFileURL(PROMPT_SOURCE_PATH).href,
    pathToFileURL(__filename).href,
  );

  if (typeof promptModule.PromptCompiler !== "function") {
    throw new Error("@kaguya/prompt does not export PromptCompiler");
  }
  return promptModule.PromptCompiler;
}

function buildFragments(kind, vars) {
  switch (kind) {
    case "route":
      return [
        fragment(
          "route-persona",
          "persona",
          10,
          requireString(vars.persona, "persona"),
        ),
        historyFragment("route-history", requireArray(vars.history, "history")),
        memoriesFragment(
          "route-memory",
          requireArray(vars.memories, "memories"),
        ),
        fragment(
          "route-policy",
          "policy",
          40,
          requireString(vars.routePolicy, "routePolicy"),
          { scope: "route" },
        ),
      ];
    case "reply":
      return [
        fragment(
          "reply-persona",
          "persona",
          10,
          requireString(vars.persona, "persona"),
        ),
        historyFragment("reply-history", requireArray(vars.history, "history")),
        memoriesFragment(
          "reply-memory",
          requireArray(vars.memories, "memories"),
        ),
        fragment(
          "reply-policy",
          "policy",
          40,
          requireString(vars.replyPolicy, "replyPolicy"),
          { scope: "reply" },
        ),
      ];
    case "state":
      return [
        historyFragment("state-history", requireArray(vars.history, "history")),
        fragment(
          "state-current",
          "state",
          30,
          requireString(vars.currentState, "currentState"),
        ),
        fragment(
          "state-policy",
          "policy",
          40,
          requireString(vars.statePolicy, "statePolicy"),
          { scope: "state" },
        ),
      ];
    case "memory":
      return memoryFragments(vars);
    default:
      throw new Error(`unsupported prompt kind: ${kind}`);
  }
}

function memoryFragments(vars) {
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
    fragment(
      "memory-history",
      "history",
      20,
      records.map((record) => `${record.role}: ${record.content}`).join("\n"),
      {
        from: requireString(window.from, "window.from"),
        to: requireString(window.to, "window.to"),
      },
    ),
    fragment(
      "memory-policy",
      "policy",
      40,
      requireString(vars.memoryPolicy, "memoryPolicy"),
      { scope: "memory" },
    ),
  ];
}

function historyFragment(id, records) {
  return fragment(
    id,
    "history",
    20,
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

function memoriesFragment(id, records) {
  return fragment(
    id,
    "memory",
    30,
    records
      .map((value, position) => {
        const record = requireRecord(value, `memories[${position}]`);
        return requireString(record.content, `memories[${position}].content`);
      })
      .join("\n"),
  );
}

function fragment(id, source, priority, content, metadata = {}) {
  return { id, source, priority, content, metadata };
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
