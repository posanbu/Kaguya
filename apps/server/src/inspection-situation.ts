import {
  situationFrameSchema,
  situationViewSchema,
  type SituationStepView,
} from "@kaguya/schema";
import type { InspectionSource } from "./inspection.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const terminalKinds = new Set(
  ["completed", "silent", "waiting", "failed", "superseded", "interrupted"].map(
    (status) => `agent.router.turn.${status}`,
  ),
);

/** Read projection only. Opaque native continuation data never leaves this endpoint. */
export async function readSituation(ledger: InspectionSource["ledger"]) {
  const [frozen, requests] = await Promise.all([
    ledger.inspectPage({ kind: "agent.situation.frozen", limit: 51 }),
    ledger.inspectPage({
      kind: "core.model.task.requested",
      payloadIn: {
        path: ["taskId"],
        values: ["agent.light.decide", "agent.heavy.respond"],
      },
      limit: 61,
    }),
  ]);
  const frames = frozen.slice(0, 50).flatMap((atom) => {
    const result = situationFrameSchema.safeParse(atom.payload.frame);
    return result.success ? [result.data] : [];
  });
  const visibleRequests = new Map(
    requests.slice(0, 60).map((request) => [request.informationId, request]),
  );
  // The recent-call limit must not hide older unresolved actions.
  const continuity = frozen[0]?.payload.continuity;
  for (const value of Array.isArray(continuity) ? continuity : []) {
    const item = record(value);
    if (
      typeof item.status !== "string" ||
      !["pending", "waiting", "unknown"].includes(item.status) ||
      typeof item.callResultId !== "string"
    )
      continue;
    const result = await ledger.get(item.callResultId);
    const requestId = result?.references.find(
      (ref) => ref.relation === "core:status-of",
    )?.informationId;
    const request = requestId ? await ledger.get(requestId) : null;
    if (request?.kind === "core.model.task.requested")
      visibleRequests.set(request.informationId, request);
  }
  const steps: SituationStepView[] = await Promise.all(
    [...visibleRequests.values()].map(async (request) => {
      const source = await ledger.get(
        String(request.payload.sourceInformationId),
      );
      const turnId =
        source?.kind === "agent.router.turn.context.completed"
          ? source.informationId
          : record(source?.payload.turn).contextInformationId;
      const turn =
        source?.informationId === turnId
          ? source
          : typeof turnId === "string"
            ? await ledger.get(turnId)
            : null;
      const candidateId = turn?.payload.candidateInformationId;
      const [results, decisions] = await Promise.all([
        ledger.inspectPage({
          referencedId: request.informationId,
          relation: "core:status-of",
          kinds: [
            "core.model.task.completed",
            "core.model.task.failed",
            "core.model.task.cancelled",
          ],
          limit: 2,
        }),
        candidateId
          ? ledger.inspectPage({
              referencedId: String(candidateId),
              relation: "core:status-of",
              limit: 20,
            })
          : Promise.resolve([]),
      ]);
      const result = results[0];
      const terminal = decisions.find((a) => terminalKinds.has(a.kind));
      const receiptId = terminal?.payload.deliveryTerminalInformationId;
      const receipt =
        typeof receiptId === "string" ? await ledger.get(receiptId) : null;
      const output =
        result?.kind === "core.model.task.completed"
          ? result.payload.output
          : null;
      const value: Record<string, unknown> | null =
        output && typeof output === "object" && !Array.isArray(output)
          ? (output as Record<string, unknown>)
          : null;
      const native = result?.payload.native;
      const parts = record(native).reasoning;
      const reasoning =
        (Array.isArray(parts) ? parts : [])
          .flatMap((part) => {
            const text = record(part).text;
            return typeof text === "string" ? [text] : [];
          })
          .join("\n") || null;
      const frame = frames.find((f) => f.id === turnId);
      return {
        id: request.informationId,
        frameId: typeof turnId === "string" ? turnId : null,
        sceneId: frame?.current.sceneId ?? String(turn?.payload.scopeKey ?? ""),
        at: request.occurredAt,
        tier:
          request.payload.taskId === "agent.light.decide" ? "light" : "heavy",
        phase: request.payload.inputBlocked
          ? "blocked"
          : result?.kind === "core.model.task.completed"
            ? "completed"
            : result?.kind === "core.model.task.failed"
              ? "failed"
              : result
                ? "cancelled"
                : "requested",
        action: typeof value?.action === "string" ? value.action : null,
        text:
          typeof output === "string"
            ? output
            : typeof value?.text === "string"
              ? value.text
              : "",
        status:
          receipt?.payload.outcome === "unknown"
            ? "unknown"
            : (terminal?.kind.split(".").at(-1) ?? "pending"),
        reasoning,
        nativeAvailable: !!native,
        receipt: receipt ? JSON.stringify(receipt.payload) : null,
      };
    }),
  );
  return situationViewSchema.parse({
    version: 1,
    frames,
    steps,
    truncated: frozen.length > 50 || requests.length > 60,
  });
}
