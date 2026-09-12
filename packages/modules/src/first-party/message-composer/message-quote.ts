/**
 * 功能概述：在消息编写的授权原子中只读解析入站引用，不给 assistant.source 补写平台消息 ID。
 * 主要职责：resolveMessageQuote 同时检查普通入站消息与成功 receipt→request→assistant 链，
 * 对目标、冻结 asOf 和引用唯一性逐项校验；多条候选或不完整链均不猜测。
 * sameMessageTarget 比较平台、适配器和会话目标；beforeQuoteCutoff 统一冻结时间的包含端点语义。
 * 代码库关系：message-context 负责加载原始账本事实，message-prompt 复用同一规则编译引用。
 * 输入输出与副作用：返回被引用消息及完整 provenance 原子；无写入、缓存或网络副作用。
 */
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";
import {
  assistantTextInformationKind,
  inboundTextInformationKind,
} from "../information-kinds.js";

type Atom = DeepReadonly<InformationAtom>;
type Target = {
  readonly platform: string;
  readonly adapterId: string;
  readonly destination: {
    readonly kind: string;
    readonly groupId?: string;
    readonly userId?: string;
  };
};

export function sameMessageTarget(value: unknown, target: Target): boolean {
  if (value === null || typeof value !== "object") return false;
  const source = value as Target;
  const destination = source.destination;
  return (
    source.platform === target.platform &&
    source.adapterId === target.adapterId &&
    destination?.kind === target.destination.kind &&
    destination?.groupId === target.destination.groupId &&
    destination?.userId === target.destination.userId
  );
}

export function beforeQuoteCutoff(atom: Atom, asOf: string): boolean {
  return Date.parse(atom.occurredAt) <= Date.parse(asOf);
}

export function resolveMessageQuote(
  atoms: readonly Atom[],
  platformMessageId: string,
  target: Target,
  asOf: string,
): { message: Atom; provenance: readonly Atom[] } | undefined {
  const available = [
    ...new Map(
      atoms
        .filter((atom) => beforeQuoteCutoff(atom, asOf))
        .map((atom) => [atom.informationId, atom]),
    ).values(),
  ];
  const inbound = available.filter(
    (atom) =>
      atom.kind === inboundTextInformationKind.kind &&
      sameMessageTarget(atom.payload.source, target) &&
      inboundTextInformationKind.payloadSchema.safeParse(atom.payload).data
        ?.source.platformMessageId === platformMessageId,
  );
  const receipts = available.filter(
    (atom) =>
      atom.kind === "core.delivery.delivered" &&
      atom.payload.ok === true &&
      atom.payload.platformMessageId === platformMessageId &&
      sameMessageTarget(
        { ...atom.payload, destination: atom.payload.target },
        target,
      ),
  );
  // 即使其中某条回执的因果链缺失，也不能用另一条猜测同一个平台 ID 的归属。
  if (inbound.length + receipts.length !== 1) return undefined;
  if (inbound[0]) return { message: inbound[0], provenance: [inbound[0]] };
  const receipt = receipts[0]!;
  const request = uniqueReference(receipt, "core:status-of", available);
  if (
    request?.kind !== "core.delivery.requested" ||
    !sameMessageTarget(request.payload, target)
  )
    return undefined;
  const assistant = uniqueReference(request, "core:caused-by", available);
  if (
    assistant?.kind !== assistantTextInformationKind.kind ||
    !sameMessageTarget(assistant.payload.source, target) ||
    !assistantTextInformationKind.payloadSchema.safeParse(assistant.payload)
      .success
  )
    return undefined;
  return { message: assistant, provenance: [receipt, request, assistant] };
}

function uniqueReference(
  atom: Atom,
  relation: string,
  atoms: readonly Atom[],
): Atom | undefined {
  const references = atom.references.filter(
    (reference) => reference.relation === relation,
  );
  return references.length === 1
    ? atoms.find(
        (candidate) => candidate.informationId === references[0]!.informationId,
      )
    : undefined;
}
