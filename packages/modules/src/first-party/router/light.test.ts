/** Current Light contract and immutable two-block Memory Prompt. */
import { describe, expect, it } from "vitest";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { atom, fixture, identity } from "../heavy/test-fixtures.js";
import {
  compileLightPrompt,
  lightActionSchema,
  lightActionSchemaForTurn,
} from "./light.js";
import { frozenRawContextInformationKind } from "./raw-context.js";

const template = loadFirstPartyPromptTemplates().light;

describe("Light contract", () => {
  it.each([
    { action: "message", reason: "respond", text: "forbidden" },
    { action: "message", reason: "respond", composition: { topic: "old" } },
    { action: "message", reason: "respond", adapterId: "qq" },
    { action: "silent", reason: "light-unavailable" },
    { action: "wait", reason: "await-more-context", waitSeconds: 4 },
    { action: "wait", reason: "await-more-context", waitSeconds: 121 },
  ])("rejects unauthorized output %j", (output) => {
    expect(lightActionSchema.safeParse(output).success).toBe(false);
  });

  it("enforces the frozen wait budget", () => {
    const available = lightActionSchemaForTurn({
      inputs: [{}],
      attempt: 0,
      totalWaitBudget: 1,
    });
    const exhausted = lightActionSchemaForTurn({
      inputs: [{}],
      attempt: 1,
      totalWaitBudget: 1,
    });
    const wait = {
      action: "wait",
      reason: "await-more-context",
      waitSeconds: 5,
    };
    expect(available.safeParse(wait).success).toBe(true);
    expect(exhausted.safeParse(wait).success).toBe(false);
    expect(
      exhausted.safeParse({ action: "message", reason: "respond" }).success,
    ).toBe(true);
  });

  it("uses the frozen Memory text and provenance without history or turn variables", () => {
    const f = fixture(["FIRST_INPUT", "LAST_INPUT"]);
    const global = "跨范围事件：GLOBAL_SENTINEL";
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
    const prompt = compileLightPrompt(identity, selected, f.turn, template);
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
    expect(prompt.text).toContain('"availableActions":["message","silent"]');
  });

  it("rejects a turn without its frozen Memory snapshot", () => {
    const f = fixture();
    expect(() =>
      compileLightPrompt(
        identity,
        f.atoms.filter((item) => item.informationId !== f.raw.informationId),
        f.turn,
        template,
      ),
    ).toThrow("frozen raw Memory");
  });
});
