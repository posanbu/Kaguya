import { describe, expect, it, vi } from "vitest";
import {
  cognitiveFixture,
  modelToken,
} from "../test-support/cognitive-fixture.js";
import { createContinuityModule } from "./index.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { identity } from "../heavy/test-fixtures.js";

describe("continuous self and activity module", () => {
  it("imports the persona into native self once, keeps autonomy off and reuses it after restart", async () => {
    const f = await cognitiveFixture([
      createContinuityModule({
        modelTaskCapability: modelToken,
        template: loadFirstPartyPromptTemplates().continuity,
        identity,
      }),
    ]);
    try {
      await vi.waitFor(async () =>
        expect(
          await f.database.memoryGraph.native.readFixed({
            scope: "shared",
            owners: ["self:kaguya"],
            query: "",
            asOf: "2026-09-10T00:00:00Z",
          }),
        ).toHaveLength(1),
      );
      expect(f.calls).toBe(0);
      const first = await f.all("agent.continuity.internal-source.v1");
      expect(first).toHaveLength(1);
      expect(first[0]?.payload).toMatchObject({
        type: "persona-seed",
        ownerId: "self:kaguya",
        text: identity.persona,
      });
      await f.restart();
      expect(await f.all("agent.continuity.policy.v1")).toHaveLength(1);
      expect(await f.all("agent.continuity.internal-source.v1")).toHaveLength(
        1,
      );
      expect(await f.all("core.message.inbound.text")).toHaveLength(0);
      expect(f.calls).toBe(0);
      expect(await f.all("consumer.failed")).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
