import { describe, expect, it } from "vitest";
import {
  freezeInformationAtom,
  z,
  jsonValueSchema,
  situationViewSchema,
  type InformationAtom,
  type SituationView,
} from "@kaguya/schema";
import { readSituation } from "./inspection-situation.js";
import {
  createInspectionService,
  type InspectionSource,
} from "./inspection.js";

const at = "2026-10-20T12:00:00.000Z";
const scene = '["qq","test","group","test-group"]';
function atom(
  informationId: string,
  kind: string,
  payload: Record<string, unknown>,
  references: InformationAtom["references"] = [],
) {
  return freezeInformationAtom({
    informationId,
    kind,
    payload: z.record(z.string(), jsonValueSchema).parse(payload),
    references,
    occurredAt: at,
    source: "test:situation",
  });
}
function frame(id = "turn"): SituationView["frames"][number] {
  return {
    contractVersion: "1.0.0",
    id,
    agentId: "test-agent",
    frozenAt: at,
    background: { through: 0, evidence: [], continuation: false },
    current: { sceneId: scene, evidence: [] },
    recalls: [],
    changes: {
      baseManifestId: null,
      evidenceIds: [],
      invalidatedEvidenceIds: [],
    },
  };
}
function ledger(rows: ReturnType<typeof atom>[]): InspectionSource["ledger"] {
  return {
    get: async (id) => rows.find((row) => row.informationId === id),
    inspectPage: async (query) =>
      rows
        .filter(
          (row) =>
            (!query.kind || row.kind === query.kind) &&
            (!query.kinds || query.kinds.includes(row.kind)) &&
            (!query.payloadIn ||
              query.payloadIn.values.includes(
                String(row.payload[query.payloadIn.path[0]!]),
              )) &&
            (!query.referencedId ||
              row.references.some(
                (ref) =>
                  ref.informationId === query.referencedId &&
                  (!query.relation || ref.relation === query.relation),
              )),
        )
        .slice(0, query.limit ?? 50),
  };
}
const statusOf = (informationId: string) => [
  { relation: "core:status-of", informationId },
];
const turn = atom("turn", "agent.router.turn.context.completed", {
  candidateInformationId: "candidate",
  scopeKey: scene,
});
const requested = (id: string, extra: InformationAtom["payload"] = {}) =>
  atom(id, "core.model.task.requested", {
    taskId: "agent.light.decide",
    sourceInformationId: "turn",
    ...extra,
  });

describe("read-only situation projection", () => {
  it("keeps saved reasoning and delivery uncertainty, redacts secrets, and excludes native messages", async () => {
    const rows = [
      atom("frozen", "agent.situation.frozen", { frame: frame() }),
      requested("request", { taskId: "agent.heavy.respond" }),
      turn,
      atom(
        "result",
        "core.model.task.completed",
        {
          output: { action: "message", text: "saved answer test-only-secret" },
          native: {
            messages: [{ role: "assistant", content: "opaque-native-message" }],
            reasoning: [{ text: "saved reasoning" }],
            providerMetadata: { opaque: "opaque-provider-data" },
          },
        },
        statusOf("request"),
      ),
      atom(
        "context-decoy",
        "agent.router.turn.context.completed",
        {},
        statusOf("candidate"),
      ),
      atom(
        "terminal",
        "agent.router.turn.completed",
        { deliveryTerminalInformationId: "receipt" },
        statusOf("candidate"),
      ),
      atom("receipt", "delivery.completed", { outcome: "unknown" }),
    ];
    const view = situationViewSchema.parse(
      await createInspectionService({
        ledger: ledger(rows),
        modules: () => [],
        secrets: { apiKey: "test-only-secret" },
      }).situation(),
    );
    expect(view.frames).toEqual([frame()]);
    expect(view.steps[0]).toMatchObject({
      id: "request",
      frameId: "turn",
      sceneId: scene,
      tier: "heavy",
      phase: "completed",
      action: "message",
      text: "saved answer [REDACTED]",
      status: "unknown",
      reasoning: "saved reasoning",
      nativeAvailable: true,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /opaque-native-message|opaque-provider-data|test-only-secret/,
    );
  });

  it("separates requested, blocked, failed, cancelled and completed phases without inventing reasoning", async () => {
    const rows = [
      turn,
      requested("pending"),
      requested("blocked", { inputBlocked: "context-budget" }),
      requested("failed"),
      requested("cancelled"),
      requested("completed"),
      atom("failure", "core.model.task.failed", {}, statusOf("failed")),
      atom(
        "cancellation",
        "core.model.task.cancelled",
        {},
        statusOf("cancelled"),
      ),
      atom(
        "completion",
        "core.model.task.completed",
        { output: { action: "silent" } },
        statusOf("completed"),
      ),
    ];
    const view = await readSituation(ledger(rows));
    expect(
      view.steps.map(({ id, phase, reasoning }) => ({ id, phase, reasoning })),
    ).toEqual([
      { id: "pending", phase: "requested", reasoning: null },
      { id: "blocked", phase: "blocked", reasoning: null },
      { id: "failed", phase: "failed", reasoning: null },
      { id: "cancelled", phase: "cancelled", reasoning: null },
      { id: "completed", phase: "completed", reasoning: null },
    ]);
    expect(view.steps.find((step) => step.id === "failed")?.action).toBeNull();
  });

  it("bounds recent rows while retaining an older unresolved request from continuity", async () => {
    const rows = [
      ...Array.from({ length: 51 }, (_, index) =>
        atom(`frozen:${index}`, "agent.situation.frozen", {
          frame: frame(`turn:${index}`),
          continuity:
            index === 0
              ? [{ status: "waiting", callResultId: "old-result" }]
              : [],
        }),
      ),
      ...Array.from({ length: 61 }, (_, index) =>
        requested(`request:${index}`),
      ),
      requested("old-request"),
      turn,
      atom(
        "old-result",
        "core.model.task.completed",
        { output: { action: "wait" } },
        statusOf("old-request"),
      ),
    ];
    const view = await readSituation(ledger(rows));
    expect(view.truncated).toBe(true);
    expect(view.frames).toHaveLength(50);
    expect(view.steps).toHaveLength(61);
    expect(view.steps.some((step) => step.id === "request:60")).toBe(false);
    expect(view.steps.at(-1)).toMatchObject({
      id: "old-request",
      action: "wait",
    });
  });
});
