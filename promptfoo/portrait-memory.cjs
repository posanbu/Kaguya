/** 用独立内存库评测合成对话，复用生产 Memory 的来源、发布与读取。 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const DEFAULT_SCOPE = JSON.stringify(["qq", "eval", "group", "group-1"]);

async function loadTemplates(loader, source) {
  // Copy only default templates. A developer's local overrides must not change a comparison.
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "kaguya-portrait-templates-"),
  );
  try {
    for (const name of fs
      .readdirSync(source)
      .filter((n) => n.endsWith(".default.hbs")))
      fs.copyFileSync(path.join(source, name), path.join(temporary, name));
    return loader.loadFirstPartyPromptTemplates({
      root: pathToFileURL(temporary + path.sep),
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function createPortraitMemory(modules, people) {
  const db = await modules.database.createTestingDatabase();
  try {
    await db.prepareSchema();
    const kinds = [
      "core.message.inbound.text",
      "memory.identity.platform.account.entity",
      "memory.identity.platform.account.binding",
    ];
    await db.information.synchronizeKinds(kinds);
    const append = async (
      informationId,
      kind,
      payload,
      occurredAt,
      references = [],
    ) =>
      db.information.append(
        modules.schema.freezeInformationAtom(
          modules.schema.informationAtomSchema.parse({
            informationId,
            kind,
            payload,
            occurredAt,
            references,
            source: "eval:portrait",
          }),
        ),
        references.map((r) => ({
          relation: r.relation,
          required: true,
          multiple: false,
        })),
      );
    for (const person of [...people, { id: "observer", name: "提问者" }]) {
      await append(
        `account:${person.id}`,
        kinds[1],
        { platform: "qq", adapterId: "eval", accountId: person.id },
        "2020-01-01T00:00:00.000Z",
      );
      await append(
        `binding:${person.id}`,
        kinds[2],
        { personInformationId: person.id },
        "2020-01-01T00:00:00.000Z",
        [{ relation: "core:binds", informationId: `account:${person.id}` }],
      );
    }
    const memory = modules.memory.createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    });
    const originals = new Map();
    return {
      db,
      memory,
      async ingest(message, scope, at) {
        const [, , kind, id] = JSON.parse(scope);
        const reply = message.replyTo
          ? originals.get(message.replyTo)
          : undefined;
        if (message.replyTo && (!reply || reply.scope !== scope))
          throw new Error("Invalid scenario reply reference");
        const address = {
          platform: "qq",
          adapterId: "eval",
          senderId: message.speaker,
          selfId: "bot-1",
          sender: {
            userId: message.speaker,
            nickname: people.find((p) => p.id === message.speaker).name,
          },
          destination:
            kind === "private" ? { kind, userId: id } : { kind, groupId: id },
          mentions: (message.mentions || []).map((id) => ({
            kind: "user",
            id,
          })),
          ...(reply
            ? {
                replyTo: {
                  platformMessageId: message.replyTo,
                  senderId: reply.speaker,
                },
              }
            : {}),
        };
        const occurredAt = message.at || at;
        await append(
          message.id,
          kinds[0],
          { text: message.text, source: address },
          occurredAt,
        );
        const source = {
          id: message.id,
          scope,
          ownerId: `person:${message.speaker}`,
          text: message.text,
          occurredAt,
          collectedAt: at,
          sourceType: "inbound",
          participants: await modules.collection.sourceParticipants(
            address,
            `person:${message.speaker}`,
            memory,
          ),
          replyTo: reply
            ? { platformMessageId: message.replyTo, senderId: reply.speaker }
            : null,
        };
        if (!(await db.memoryGraph.native.ingest(source)))
          throw new Error("Scenario source was not ingested");
        originals.set(message.id, { ...message, scope });
      },
      close: () => db.close(),
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

function questionFixture(messageFixture, question, scope, at, snapshot) {
  const fixture = messageFixture([question.text]);
  const [, , kind, id] = JSON.parse(scope);
  const destination =
    kind === "private" ? { kind, userId: id } : { kind, groupId: id };
  for (const atom of fixture.atoms) {
    atom.occurredAt = at;
    if (atom.payload.source)
      atom.payload.source = {
        ...atom.payload.source,
        destination,
        senderId: "observer",
        sender: { userId: "observer", nickname: "提问者" },
        mentions: [{ kind: "user", id: question.about }],
      };
    if (atom.kind === "agent.router.message.intent.requested")
      atom.payload.target.destination = destination;
    if (atom.kind === "agent.router.turn.context.completed") {
      Object.assign(atom.payload, {
        scopeKey: scope,
        asOf: at,
        isPrivate: kind === "private",
        isGroup: kind === "group",
      });
      atom.payload.backlog.evaluatedAt = at;
      atom.payload.inputs[0].occurredAt = at;
      atom.payload.inputs[0].source = atom.payload.source;
      Object.assign(atom.payload.inputs[0].identity, {
        scopeMode: "canonical",
        personInformationId: "observer",
      });
      atom.payload.bootstrap.conversation.scopeMode = "canonical";
      atom.payload.bootstrap.participants[0].ownerId = "person:observer";
    }
    if (atom.kind === "agent.router.memory.context.frozen")
      atom.payload.currentScope.text = `[未读] 提问者：${question.text}`;
  }
  const turn = fixture.atoms.find(
    (a) => a.kind === "agent.router.turn.context.completed",
  );
  fixture.atoms.push({
    informationId: "eval-frozen",
    kind: "agent.situation.frozen",
    payload: {
      turnInformationId: turn.informationId,
      frame: { memory: snapshot },
    },
  });
  return { ...fixture, turnId: turn.informationId };
}
module.exports = {
  DEFAULT_SCOPE,
  loadTemplates,
  createPortraitMemory,
  questionFixture,
};
