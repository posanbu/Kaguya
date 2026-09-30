/** Heavy reads the same frozen two-block Memory snapshot as Light. */
import { describe, expect, it } from "vitest";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { frozenRawContextInformationKind } from "../router/raw-context.js";
import { compileMessagePrompt } from "./message-prompt.js";
import { atom, fixture, identity } from "./test-fixtures.js";

const templates = loadFirstPartyPromptTemplates().heavy;

describe("Heavy message Prompt", () => {
  it("uses the exact frozen two-block text and no independent history or turn variables", () => {
    const f = fixture();
    const global = "跨范围证据 GLOBAL_SENTINEL";
    const scope = "[未读] FIRST_INPUT\n[未读] LAST_INPUT";
    const raw = atom(
      f.raw.informationId,
      frozenRawContextInformationKind.kind,
      {
        ...f.raw.payload,
        global: { text: global, informationIds: ["other-scope"] },
        currentScope: {
          text: scope,
          informationIds: f.messages.map((message) => message.informationId),
        },
        characterCount: global.length + scope.length,
      },
    );
    const selected = [
      ...f.atoms.filter((item) => item.informationId !== f.raw.informationId),
      raw,
    ];
    const prompt = compileMessagePrompt(
      templates,
      identity,
      selected,
      f.intent.informationId,
    );
    const variables = new Map(
      prompt.variables.map((variable) => [variable.name, variable]),
    );
    expect(variables.get("global_context")).toMatchObject({
      content: global,
      informationIds: [raw.informationId],
    });
    expect(variables.get("scope_context")).toMatchObject({
      content: scope,
      informationIds: [raw.informationId],
    });
    expect(variables.has("history")).toBe(false);
    expect(variables.has("turn")).toBe(false);
    expect(prompt.text).toContain(global);
    expect(prompt.text).toContain(scope);
    expect(prompt.text).toContain("保持真实自然");
  });

  it("rejects a turn without its frozen Memory snapshot", () => {
    const f = fixture();
    expect(() =>
      compileMessagePrompt(
        templates,
        identity,
        f.atoms.filter((item) => item.informationId !== f.raw.informationId),
        f.intent.informationId,
      ),
    ).toThrow("frozen raw Memory");
  });

  it("rejects an intent with mismatched turn provenance", () => {
    const f = fixture();
    const bad = atom(f.intent.informationId, f.intent.kind, {
      ...f.intent.payload,
      turn: {
        ...(f.intent.payload.turn as Record<string, unknown>),
        claimInformationId: "wrong",
      },
    });
    expect(() =>
      compileMessagePrompt(
        templates,
        identity,
        [
          bad,
          ...f.atoms.filter((item) => item.informationId !== bad.informationId),
        ],
        bad.informationId,
      ),
    ).toThrow("provenance");
  });
});
