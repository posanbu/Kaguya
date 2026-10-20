import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  situationEvidenceInputSchema,
  situationFrameSchema,
} from "@kaguya/schema";
import {
  buildSituationFrame,
  assembleSituationContext,
} from "./situation-model.js";

const suite = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/situation-action/v1/scenarios.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
describe("situation-action common contract (Kaguya)", () => {
  for (const scenario of suite.cases)
    it(scenario.id, () => {
      const evidence = scenario.events.map((value: unknown, index: number) => ({
        ...situationEvidenceInputSchema.parse(value),
        sequence: index + 1,
        receivedAt: "2026-10-20T00:00:03.000Z",
      }));
      const frame = buildSituationFrame({
        id: "F1",
        agentId: "kaguya",
        sceneId: scenario.currentSceneId,
        frozenAt: "2026-10-20T00:00:04.000Z",
        evidence,
        through: evidence.length,
        previous: null,
      });
      expect(frame.background.evidence.map((event) => event.id)).toEqual(
        scenario.expectedBackgroundIds,
      );
      expect(frame.current.evidence.map((event) => event.id)).toEqual(
        scenario.expectedCurrentIds,
      );
      expect(frame.changes.invalidatedEvidenceIds).toEqual(
        scenario.expectedInvalidatedIds ?? [],
      );
      expect(situationFrameSchema.safeParse(frame).success).toBe(true);
      const context = assembleSituationContext({
        id: "M1",
        sessionEpoch: "main-1",
        stepKey: "1",
        rules: "保持来源",
        frame,
        checkpoint: {
          id: "K0",
          revision: 0,
          previousId: null,
          coveredRanges: [],
          outcomes: [],
          openActionIds: [],
          commitments: [],
          waits: [],
        },
        actions: [],
        maxBytes: 100_000,
      });
      expect(
        JSON.parse(context.rendered).situation.current.evidenceIds,
      ).toEqual(scenario.expectedCurrentIds);
      expect(() =>
        assembleSituationContext({ ...context, maxBytes: 10 }),
      ).toThrow("BUDGET_EXCEEDED");
    });
  it("does not rewrite a frozen frame when later input changes", () => {
    const value = situationEvidenceInputSchema.parse(suite.cases[0].events[0]);
    const evidence = [{ ...value, sequence: 1, receivedAt: value.occurredAt }];
    const input = {
      id: "F1",
      agentId: "kaguya",
      sceneId: value.sceneId,
      frozenAt: value.occurredAt,
      evidence,
      through: 1,
      previous: null,
    };
    const frame = buildSituationFrame(input);
    evidence[0]!.text = "后来改动";
    expect(frame.background.evidence[0]!.text).toBe("继续查询");
    expect(() =>
      buildSituationFrame({ ...input, evidence: [...evidence, evidence[0]!] }),
    ).toThrow("Duplicate");
  });
});
