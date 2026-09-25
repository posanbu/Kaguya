/**
 * 功能概述：Heartflow 的纯状态投影与引用核验边界，从在线编排入口提取。
 * 主要职责：计算候选、claim、身份和终态关系；assessInputBacklog 按评估时间计算冻结输入年龄与积压标记。
 * 代码库关系：index.ts 负责推进与提交，本文件仅计算给定事实的状态，不执行 I/O；积压投影由 turn kind 持久化并供 Planner/Composer 消费。
 */
import {
  type DeepReadonly,
  type InformationAtom,
  type JsonObject,
} from "@kaguya/schema";
import {
  personContextCompletedInformationKind,
  turnClaimedInformationKind,
  turnCompletedInformationKind,
  turnFailedInformationKind,
  turnSilentInformationKind,
  turnSupersededInformationKind,
  turnInterruptedInformationKind,
  turnWaitingInformationKind,
} from "../information-kinds.js";

export const TURN_TERMINAL_KINDS = new Set<string>([
  turnCompletedInformationKind.kind,
  turnWaitingInformationKind.kind,
  turnSilentInformationKind.kind,
  turnFailedInformationKind.kind,
  turnSupersededInformationKind.kind,
  turnInterruptedInformationKind.kind,
]);

export interface InputBacklogAssessment {
  readonly isBacklog: boolean;
  readonly evaluatedAt: string;
  readonly oldestInputAgeMs: number;
  readonly newestInputAgeMs: number;
  readonly thresholdMs: number;
}

/** 以最晚输入是否越过阈值判断整批是否已积压，未来时间戳的年龄按零计。 */
export function assessInputBacklog(
  occurredAt: readonly string[],
  evaluatedAt: string,
  thresholdMs: number,
): InputBacklogAssessment {
  if (occurredAt.length === 0) throw new Error("Backlog requires an input");
  const evaluationTime = Date.parse(evaluatedAt);
  let oldestInputAgeMs = 0;
  let newestInputAgeMs = Number.POSITIVE_INFINITY;
  for (const time of occurredAt) {
    const age = Math.max(0, evaluationTime - Date.parse(time));
    oldestInputAgeMs = Math.max(oldestInputAgeMs, age);
    newestInputAgeMs = Math.min(newestInputAgeMs, age);
  }
  return {
    isBacklog: newestInputAgeMs > thresholdMs,
    evaluatedAt,
    oldestInputAgeMs,
    newestInputAgeMs,
    thresholdMs,
  };
}

export function referenced(
  source: DeepReadonly<InformationAtom>,
  relation: string,
  atoms: ReadonlyMap<string, DeepReadonly<InformationAtom>>,
) {
  return source.references.flatMap((reference) => {
    if (reference.relation !== relation) return [];
    const atom = atoms.get(reference.informationId);
    return atom === undefined ? [] : [atom];
  });
}

export function sameScope(left: any, right: any): boolean {
  return (
    left?.platform === right?.platform &&
    left?.adapterId === right?.adapterId &&
    JSON.stringify(left?.destination) === JSON.stringify(right?.destination)
  );
}

export function sameDeliveryScope(delivery: any, source: any): boolean {
  return (
    delivery?.ok === true &&
    delivery?.platform === source?.platform &&
    delivery?.adapterId === source?.adapterId &&
    JSON.stringify(delivery?.target) === JSON.stringify(source?.destination)
  );
}

export function identityTerminalFor(
  inboundInformationId: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  return atoms.find(
    (atom) =>
      atom.kind === personContextCompletedInformationKind.kind &&
      atom.references.some(
        (reference) =>
          reference.relation === "core:status-of" &&
          reference.informationId === inboundInformationId,
      ),
  );
}

export function hasExhaustedStatus(
  informationId: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  return atoms.some(
    (atom) =>
      atom.kind === "execution.exhausted" &&
      atom.references.some(
        (reference) =>
          reference.relation === "core:status-of" &&
          reference.informationId === informationId,
      ),
  );
}

export function turnTerminalFor(
  candidateInformationId: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  return atoms.find(
    (atom) =>
      TURN_TERMINAL_KINDS.has(atom.kind) &&
      atom.references.some(
        (reference) =>
          reference.relation === "core:status-of" &&
          reference.informationId === candidateInformationId,
      ),
  );
}

export function claimForCandidate(
  candidateInformationId: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  return atoms.find(
    (atom) =>
      atom.kind === turnClaimedInformationKind.kind &&
      (atom.payload as any).candidateInformationId === candidateInformationId,
  );
}

export function outgoingStatusTarget(
  source: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  const targetId = source.references.find(
    ({ relation }) => relation === "core:status-of",
  )?.informationId;
  return atoms.find(({ informationId }) => informationId === targetId);
}

export function terminalReferences(
  candidateInformationId: string,
  claimInformationId: string,
) {
  return [
    { relation: "core:status-of", informationId: candidateInformationId },
    { relation: "agent:turn-claim", informationId: claimInformationId },
  ];
}

export function assertTurnLink(
  candidate: DeepReadonly<InformationAtom>,
  claim: DeepReadonly<InformationAtom>,
  turnContext: DeepReadonly<InformationAtom>,
) {
  const claimPayload = claim.payload as any;
  const contextPayload = turnContext.payload as any;
  if (
    claimPayload.candidateInformationId !== candidate.informationId ||
    contextPayload.candidateInformationId !== candidate.informationId ||
    contextPayload.claimInformationId !== claim.informationId
  )
    throw new Error("Speech decision references an inconsistent turn");
}

export function compareClaims(
  left: DeepReadonly<InformationAtom>,
  right: DeepReadonly<InformationAtom>,
) {
  const byGeneration =
    ((left.payload as any).generation ?? 0) -
    ((right.payload as any).generation ?? 0);
  if (byGeneration !== 0) return byGeneration;
  const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  return byTime || left.informationId.localeCompare(right.informationId);
}

export function uniqueAtoms<T extends DeepReadonly<InformationAtom>>(
  atoms: readonly T[],
) {
  return [...new Map(atoms.map((atom) => [atom.informationId, atom])).values()];
}

export function copyOptionalIdentity(payload: any): JsonObject {
  return {
    ...(payload.scopeInformationId === undefined
      ? {}
      : { scopeInformationId: payload.scopeInformationId }),
    ...(payload.accountInformationId === undefined
      ? {}
      : { accountInformationId: payload.accountInformationId }),
    ...(payload.personInformationId === undefined
      ? {}
      : { personInformationId: payload.personInformationId }),
  };
}
