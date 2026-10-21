/** Freeze identity registration evidence. Registration never measures acquaintance. */
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";
import {
  chatScopeEntityInformationKind,
  personEntityInformationKind,
  type TurnBootstrapProjection,
} from "../information-kinds.js";

export interface BootstrapTurnInput {
  readonly inbound: DeepReadonly<InformationAtom>;
  readonly identity: DeepReadonly<InformationAtom>;
}
export function buildTurnBootstrap(
  inputs: readonly BootstrapTurnInput[],
  atoms: readonly DeepReadonly<InformationAtom>[],
): TurnBootstrapProjection {
  const inputIds = new Set(inputs.map((i) => i.inbound.informationId));
  function registration(id: unknown, kind: string) {
    const entity = atoms.find((a) => a.informationId === id && a.kind === kind);
    if (!entity) return null;
    const sourceIds = entity.references
      .filter((r) => r.relation === "core:caused-by")
      .map((r) => r.informationId);
    return {
      informationId: entity.informationId,
      recordedAt: entity.occurredAt,
      sourceIds,
      createdInCurrentInputs: sourceIds.some((id) => inputIds.has(id)),
    };
  }
  const last = inputs.at(-1)!.identity.payload;
  return {
    version: 2,
    conversation: {
      scopeMode: last.scopeMode === "ephemeral" ? "ephemeral" : "canonical",
      registration: registration(
        last.scopeInformationId,
        chatScopeEntityInformationKind.kind,
      ),
    },
    participants: inputs.map(({ inbound, identity }) => ({
      inputInformationId: inbound.informationId,
      ownerId:
        typeof identity.payload.personInformationId === "string"
          ? `person:${identity.payload.personInformationId}`
          : null,
      registration: registration(
        identity.payload.personInformationId,
        personEntityInformationKind.kind,
      ),
    })),
  };
}
