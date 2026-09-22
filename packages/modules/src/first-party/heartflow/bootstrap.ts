/**
 * 功能概述：从身份实体、冻结输入和已授权 Memory 构造可重放的冷启动投影。
 * 主要职责：区分首次/已知/临时会话与人物，并把 Memory 关闭和本轮无证据分开。
 * 输入输出与副作用：纯函数；不查询账本、不调用模型、不把昵称或平台 ID 当作熟悉度证据。
 */
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";
import type { TurnBootstrapProjection } from "../information-kinds.js";
import {
  chatScopeEntityInformationKind,
  personEntityInformationKind,
} from "../information-kinds.js";

export interface BootstrapTurnInput {
  readonly inbound: DeepReadonly<InformationAtom>;
  readonly identity: DeepReadonly<InformationAtom>;
}

export function buildTurnBootstrap(
  inputs: readonly BootstrapTurnInput[],
  atoms: readonly DeepReadonly<InformationAtom>[],
  memoryEnabled: boolean,
  selectedMemoryCount: number,
): TurnBootstrapProjection {
  const inputIds = new Set(inputs.map(({ inbound }) => inbound.informationId));
  const byId = new Map(atoms.map((atom) => [atom.informationId, atom]));
  const lastIdentity = inputs.at(-1)!.identity.payload as Record<
    string,
    unknown
  >;
  const conversationState = entityState(
    lastIdentity.scopeMode,
    lastIdentity.scopeInformationId,
    chatScopeEntityInformationKind.kind,
    inputIds,
    byId,
  );
  const participants = inputs.map(({ inbound, identity }) => {
    const payload = identity.payload as Record<string, unknown>;
    return {
      inputInformationId: inbound.informationId,
      state: personState(payload.personInformationId, inputIds, byId),
    };
  });
  const memoryState = !memoryEnabled
    ? "disabled"
    : selectedMemoryCount === 0
      ? "no-authorized-evidence"
      : "available";
  const anyKnownPerson = participants.some(({ state }) => state === "known");
  const noGroundedContext =
    memoryState !== "available" &&
    conversationState !== "known" &&
    !anyKnownPerson;
  const established =
    memoryState === "available" ||
    (conversationState === "known" &&
      participants.every(({ state }) => state === "known"));
  return {
    version: 1,
    mode: established
      ? "established"
      : noGroundedContext
        ? "cold-start"
        : "warming",
    memory: { state: memoryState, selectedCount: selectedMemoryCount },
    conversation: { state: conversationState },
    participants,
  };
}

function entityState(
  scopeMode: unknown,
  informationId: unknown,
  expectedKind: string,
  inputIds: ReadonlySet<string>,
  byId: ReadonlyMap<string, DeepReadonly<InformationAtom>>,
): "first-seen" | "known" | "ephemeral" | "unresolved" {
  if (scopeMode === "ephemeral") return "ephemeral";
  if (typeof informationId !== "string") return "unresolved";
  const entity = byId.get(informationId);
  if (entity?.kind !== expectedKind) return "unresolved";
  return causedByCurrentInput(entity, inputIds) ? "first-seen" : "known";
}

function personState(
  informationId: unknown,
  inputIds: ReadonlySet<string>,
  byId: ReadonlyMap<string, DeepReadonly<InformationAtom>>,
): "first-seen" | "known" | "unresolved" {
  if (typeof informationId !== "string") return "unresolved";
  const entity = byId.get(informationId);
  if (entity?.kind !== personEntityInformationKind.kind) return "unresolved";
  return causedByCurrentInput(entity, inputIds) ? "first-seen" : "known";
}

function causedByCurrentInput(
  entity: DeepReadonly<InformationAtom>,
  inputIds: ReadonlySet<string>,
): boolean {
  return entity.references.some(
    ({ relation, informationId }) =>
      relation === "core:caused-by" && inputIds.has(informationId),
  );
}
