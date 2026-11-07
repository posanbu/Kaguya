/**
 * 功能概述：把匿名回复节奏案例接到生产 Light/Heavy Prompt 编译器，生成可冻结的请求预览。
 * 主要职责：assemble 验证并选择可见输入，复用 messageFixture 构造 turn/intent，加载 default 模板和
 * 当前输出 schema，调用 compileLightPrompt、compileMessagePrompt 与生产 JSON 协议渲染器。
 * 代码库关系：复用 promptfoo/message-fixture.cjs、modules 编译器和 llm/protocol-prompt.ts；
 * 本工具只复现编译边界，不运行 Runtime、Memory 形成、Router 调度、工具循环或模型服务。
 * 输入输出与副作用：只读仓库源码/default 模板，输出 Prompt、schema、模板与编译器哈希；
 * 不读取 profile/local 模板或参考回复。媒体只有缺失标记，不加载附件，不推断未读取的内容。
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { PROTOCOL, candidateInput, digest } = require("./protocol.cjs");
const root = path.resolve(__dirname, "../..");
const sourcePaths = {
  light: "packages/modules/src/first-party/router/light.ts",
  heavy: "packages/modules/src/first-party/heavy/message-prompt.ts",
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
let modules;
function loadModules() {
  const { tsImport } = require("tsx/esm/api");
  const load = (source) =>
    tsImport(
      pathToFileURL(path.join(root, source)).href,
      pathToFileURL(__filename).href,
    );
  return (modules ??= Promise.all([
    load(sourcePaths.light),
    load(sourcePaths.heavy),
    load("packages/modules/src/first-party/heavy/index.ts"),
    load("packages/modules/src/prompt-declarations.ts"),
    load("packages/llm/src/protocol-prompt.ts"),
    load("packages/schema/src/index.ts"),
  ]));
}
function frozenAtoms(input) {
  const { messageFixture } = require("../../promptfoo/message-fixture.cjs");
  const fixture = messageFixture(input.turnMessageIds.map(() => "fixture"));
  const turn = fixture.atoms.find(
    (atom) => atom.kind === "agent.router.turn.context.completed",
  );
  const raw = fixture.atoms.find(
    (atom) => atom.kind === "agent.router.memory.context.frozen",
  );
  const intent = fixture.atoms.find(
    (atom) => atom.informationId === fixture.intentId,
  );
  const makeText = (message) =>
    message.text +
    (message.mediaTypes.length
      ? `\n[媒体内容缺失：${message.mediaTypes.join("、")}]`
      : "");
  const messages = input.messages.map((message) => ({
    informationId: message.id,
    kind: "core.message.inbound.text",
    source: "eval:reply-rhythm",
    occurredAt: message.receivedAt,
    references: [],
    payload: {
      text: makeText(message),
      source: {
        ...intent.payload.target,
        senderId: message.sender,
        selfId: "bot-1",
        platformMessageId: message.id,
        ...(message.replyTo
          ? { replyTo: { platformMessageId: message.replyTo } }
          : {}),
      },
    },
  }));
  const current = messages.filter((message) =>
    input.turnMessageIds.includes(message.informationId),
  );
  turn.occurredAt = input.cutoff;
  Object.assign(turn.payload, {
    asOf: input.cutoff,
    observedThroughInformationId: current.at(-1).informationId,
    inputs: current.map((message) => ({
      informationId: message.informationId,
      occurredAt: message.occurredAt,
      ...message.payload,
      identity: {
        terminalInformationId: "identity-1",
        status: "complete",
        scopeMode: "ephemeral",
      },
    })),
    source: current[0].payload.source,
    messageCount: current.length,
    backlog: {
      isBacklog: false,
      evaluatedAt: input.cutoff,
      oldestInputAgeMs:
        Date.parse(input.cutoff) - Date.parse(current[0].occurredAt),
      newestInputAgeMs:
        Date.parse(input.cutoff) - Date.parse(current.at(-1).occurredAt),
      thresholdMs: 120000,
    },
    bootstrap: {
      version: 2,
      conversation: { scopeMode: "ephemeral", registration: null },
      participants: current.map((message) => ({
        inputInformationId: message.informationId,
        ownerId: null,
        registration: null,
      })),
    },
  });
  turn.payload.backlog.isBacklog =
    turn.payload.backlog.oldestInputAgeMs > 120000;
  const scopeText = input.messages
    .map(
      (message) =>
        `[${input.turnMessageIds.includes(message.id) ? "未读" : "已读"}] ${message.sender} 于 ${message.receivedAt} 发送（${message.id}）：${makeText(message)}${message.replyTo ? `\n引用已观察消息：${message.replyTo}` : ""}`,
    )
    .join("\n");
  raw.payload.currentScope = {
    text: scopeText,
    informationIds: messages.map((message) => message.informationId),
  };
  raw.payload.characterCount = scopeText.length;
  return {
    atoms: [intent, turn, raw, ...messages],
    turn,
    intentId: fixture.intentId,
  };
}
async function assemble(item) {
  const input = candidateInput(item);
  const [light, heavy, heavyModule, declarations, protocol, schema] =
    await loadModules();
  const templateHashes = {};
  const readDefault = (stem) => {
    const file = `packages/modules/templates/${stem}.default.hbs`;
    const value = fs.readFileSync(path.join(root, file), "utf8");
    templateHashes[file] = sha(value);
    return value;
  };
  const heavyTemplates = Object.fromEntries(
    declarations.messageTemplateDeclarations.map((entry) => [
      entry.key,
      readDefault(entry.fileStem),
    ]),
  );
  heavyTemplates.behavior = readDefault("heavy.behavior");
  heavyTemplates.platformStyles = Object.fromEntries(
    ["default", "qq", "web"].map((kind) => [
      kind,
      readDefault(
        `heavy.platform-style${kind === "default" ? "" : `-${kind}`}`,
      ),
    ]),
  );
  const identity = {
    name: "Kaguya",
    aliases: ["辉夜"],
    persona: input.persona,
    timeZone: "Asia/Shanghai",
  };
  const { atoms, turn, intentId } = frozenAtoms(input);
  const compiled = {
    light: light.compileLightPrompt(
      identity,
      atoms,
      turn,
      readDefault("light.decision"),
      Object.fromEntries(
        ["default", "qq", "web"].map((kind) => [
          kind,
          readDefault(
            `light.platform-policy${kind === "default" ? "" : `-${kind}`}`,
          ),
        ]),
      ),
      readDefault("light.bootstrap-policy"),
    ),
    heavy: heavy.compileMessagePrompt(
      heavyTemplates,
      identity,
      atoms,
      intentId,
    ),
  };
  const protocolPath =
    "packages/llm/templates/structured-output-json.default.hbs";
  const protocolText = fs.readFileSync(path.join(root, protocolPath), "utf8");
  templateHashes[protocolPath] = sha(protocolText);
  const render = protocol.createStructuredOutputPromptRenderer(protocolText);
  const schemas = {
    light: light.lightActionSchemaForTurn(turn.payload),
    heavy: heavyModule.messageResponseWithoutRecallSchema,
  };
  const requests = Object.fromEntries(
    Object.entries(compiled).map(([kind, prompt]) => {
      const outputSchema = schema.z.toJSONSchema(schemas[kind], {
        io: "input",
      });
      const request = render(prompt, outputSchema);
      return [
        kind,
        {
          prompt: request.text,
          promptSha256: sha(request.text),
          outputSchema,
          compiler: sourcePaths[kind],
          compilerSha256: sha(
            fs.readFileSync(path.join(root, sourcePaths[kind])),
          ),
          variables: request.variables,
        },
      ];
    }),
  );
  return {
    protocol: PROTOCOL,
    caseId: item.id,
    dataKind: item.dataKind,
    inputSha256: digest(input),
    assembly: "production-compilers/default-templates/memory-off",
    networkRequests: 0,
    mediaContent: input.messages.some((message) => message.mediaTypes.length)
      ? "missing"
      : "none",
    templateHashes,
    requests,
  };
}
module.exports = { assemble };
