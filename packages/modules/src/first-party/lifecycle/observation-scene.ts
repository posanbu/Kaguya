/**
 * 功能概述：为 Lifecycle 观察的 owner、选择器及开放槽提供完整 scene 身份，旧 scope 仅作账本索引别名。
 * observationAddress 校验来源地址；resolveObservationAddress 沿候选、claim、调度的显式引用恢复旧事实归属。
 * 读取最多 64 个关联事实；缺失、超限或多个地址时不猜测归属，也不改写或关闭旧任务。
 * 代码库关系：observation-state/recovery 使用账本或已选事实调用解析器；observation.ts 用 sceneIdentity 竞争槽。
 * 输入输出与副作用：输入冻结原子与只读加载函数，返回确定的地址或 undefined；无写入和平台请求。
 */
import {
  sceneIdentity,
  legacyHeartbeatScope,
  type SceneAddress,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";

type Atom = DeepReadonly<InformationAtom>;
export function observationAddress(value: unknown): SceneAddress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (
    typeof p.platform !== "string" ||
    typeof p.adapterId !== "string" ||
    !p.destination ||
    typeof p.destination !== "object"
  )
    return undefined;
  const d = p.destination as Record<string, unknown>;
  if (d.kind === "group" && typeof d.groupId === "string")
    return {
      platform: p.platform,
      adapterId: p.adapterId,
      destination: { kind: "group", groupId: d.groupId },
    };
  if (d.kind === "private" && typeof d.userId === "string")
    return {
      platform: p.platform,
      adapterId: p.adapterId,
      destination: { kind: "private", userId: d.userId },
    };
  if (
    d.kind === "web" &&
    (d.conversationId === undefined || typeof d.conversationId === "string")
  )
    return {
      platform: p.platform,
      adapterId: p.adapterId,
      destination: {
        kind: "web",
        ...(d.conversationId === undefined
          ? {}
          : { conversationId: d.conversationId }),
      },
    };
  return undefined;
}

export async function resolveObservationAddress(
  atom: Atom,
  read: (id: string) => Promise<Atom | undefined>,
): Promise<SceneAddress | undefined> {
  const pending = [atom];
  const seen = new Set<string>();
  const loaded = new Set<string>([atom.informationId]);
  const addresses = new Map<string, SceneAddress>();
  while (pending.length) {
    const current = pending.shift()!;
    if (seen.has(current.informationId)) continue;
    if (seen.size >= 64) return undefined;
    seen.add(current.informationId);
    const p = current.payload;
    const input = p.input as Record<string, unknown> | undefined;
    const direct =
      observationAddress(p.source) ??
      observationAddress(p) ??
      observationAddress(input?.sceneAddress);
    if (direct) {
      addresses.set(sceneIdentity(direct), direct);
      if (addresses.size > 1) return undefined;
      continue;
    }
    const ids = new Set(
      current.references
        .filter((r) =>
          [
            "core:status-of",
            "core:caused-by",
            "agent:turn-candidate",
            "agent:turn-claim",
          ].includes(r.relation),
        )
        .map((r) => String(r.informationId)),
    );
    for (const id of [p.candidateInformationId, input?.heartbeatInformationId])
      if (typeof id === "string") ids.add(id);
    for (const id of ids) {
      if (loaded.has(id)) continue;
      if (loaded.size >= 64) return undefined;
      loaded.add(id);
      const next = await read(id);
      if (next) pending.push(next);
    }
  }
  const address = addresses.values().next().value;
  const scope = (atom.payload.input as Record<string, unknown> | undefined)
    ?.scopeKey;
  if (
    address &&
    typeof scope === "string" &&
    scope !== legacyHeartbeatScope(address)
  )
    return undefined;
  return address;
}
