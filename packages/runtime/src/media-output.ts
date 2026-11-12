/**
 * 功能概述：在真实投递前核验有序图片输出的模型来源、持久媒体快照、目标场景及原始字节。
 * resolveOutboundImages 沿助手的明确因果链寻找对应 Heavy 完成事实，不把同场景或消息内 JSON 标记当授权。
 * 模型请求须包含宿主保存的原始快照；媒体 ID、资源摘要、MIME、长度和大小预算逐项核对。
 * 代码库关系：Runtime 在 W3 已准入后调用本入口，返回后仍复核取消、租约与目标权限；平台只接收核验后的字节。
 * 本文件只通过注入端口读取账本与仓储，不解析 URL/路径、不发送请求；读取失败发生在平台副作用前。
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  frozenOutboundMediaIds,
  validateOutboundMediaSelection,
  sceneIdentity,
  type DeepReadonly,
  type InformationAtom,
  type JsonValue,
  type MediaReference,
  type OutboundMessageContent,
  type SceneAddress,
} from "@kaguya/schema";
import type { MediaResourceStore } from "@kaguya/sdk";
import type { PlatformOutboundMetadata } from "@kaguya/platform-adapters";
import {
  modelTaskRequestedInformationKind,
  modelTaskCompletedInformationKind,
} from "./information-kinds.js";
import { modelTaskFingerprint } from "./model-task.js";
import { imageMime } from "./media-input.js";

type Atom = DeepReadonly<InformationAtom>;
type Content = DeepReadonly<
  Extract<OutboundMessageContent, { kind: "content" }>
>;
type Images = NonNullable<PlatformOutboundMetadata["images"]>;
const chainKinds = new Set([
  "core.message.assistant.text",
  "agent.heavy.message.prepared",
  "agent.heavy.message.draft",
  "agent.heavy.message.ready",
  "agent.heavy.message.content.confirmed",
  "core.schedule.one-shot.due",
  "core.schedule.one-shot.requested",
  "core.model.task.completed",
  "plugin.qq-expression.selection.requested.v2",
]);
function reject(): never {
  throw new Error("media-output-proof-invalid");
}
function sameContext(atom: Atom, contextId: string): boolean {
  const refs = atom.references.filter((r) => r.relation === "core:context");
  return refs.length === 1 && refs[0]!.informationId === contextId;
}
/** 只沿输出链的直接原因和节奏调度关系读取，最多 32 个事实；绝不遍历任意上下文。 */
async function completedFor(
  assistant: Atom,
  requestId: string,
  contextId: string,
  read: (id: string) => Promise<Atom | undefined>,
  signal?: AbortSignal,
): Promise<Atom> {
  const pending = [assistant],
    seen = new Set<string>();
  while (pending.length) {
    signal?.throwIfAborted();
    const atom = pending.shift()!;
    if (seen.has(atom.informationId)) continue;
    if (seen.size >= 32) reject();
    seen.add(atom.informationId);
    if (!chainKinds.has(atom.kind)) continue;
    if (atom.kind === "core.schedule.one-shot.due") {
      const refs = atom.references.filter(
        (r) => r.relation === "core:status-of",
      );
      if (
        refs.length !== 1 ||
        refs[0]!.informationId !== atom.payload.scheduleInformationId
      )
        reject();
      const schedule = await read(refs[0]!.informationId);
      if (!schedule || schedule.kind !== "core.schedule.one-shot.requested")
        reject();
      pending.push(schedule);
      continue;
    }
    if (atom.kind === "core.schedule.one-shot.requested") {
      const value = atom.payload.input as
        { purpose?: string; readyInformationId?: string } | undefined;
      const refs = atom.references.filter(
        (r) => r.relation === "core:caused-by",
      );
      if (
        value?.purpose !== "heavy-speech" ||
        refs.length !== 1 ||
        refs[0]!.informationId !== value.readyInformationId
      )
        reject();
      const ready = await read(refs[0]!.informationId);
      if (!ready || ready.kind !== "agent.heavy.message.ready") reject();
      pending.push(ready);
      continue;
    }
    if (!sameContext(atom, contextId)) continue;
    if (atom.kind === "core.model.task.completed") {
      if (
        atom.source === "runtime:model-task" &&
        atom.references.some(
          (r) =>
            r.relation === "core:status-of" && r.informationId === requestId,
        )
      )
        return atom;
      continue;
    }
    if (atom.kind === "plugin.qq-expression.selection.requested.v2") {
      const causes = atom.references.filter(
        (r) => r.relation === "core:caused-by",
      );
      if (
        causes.length !== 1 ||
        causes[0]!.informationId !== atom.payload.draftInformationId
      )
        reject();
      const draft = await read(causes[0]!.informationId);
      if (!draft || draft.kind !== "agent.heavy.message.draft") reject();
      pending.push(draft);
      continue;
    }
    const ids = atom.references
      .filter((r) => r.relation === "core:caused-by")
      .map((r) => r.informationId);
    for (const id of ids) {
      if (seen.has(id)) continue;
      const next = await read(id);
      if (next) pending.push(next);
    }
  }
  return reject();
}

export async function resolveOutboundImages(input: {
  message: Content;
  delivery: Atom;
  contextId: string;
  target: SceneAddress;
  read: (id: string) => Promise<Atom | undefined>;
  readSnapshot: (key: string, scope: string) => Promise<JsonValue | undefined>;
  readSource: (
    mediaId: string,
    scope: string,
  ) => Promise<MediaReference | undefined>;
  resources: MediaResourceStore | undefined;
  signal?: AbortSignal | undefined;
}): Promise<Images> {
  const { message, contextId, signal } = input;
  signal?.throwIfAborted();
  const causeIds = input.delivery.references.filter(
    (r) => r.relation === "core:caused-by",
  );
  if (causeIds.length !== 1) reject();
  const assistant = await input.read(causeIds[0]!.informationId);
  if (
    !assistant ||
    assistant.kind !== "core.message.assistant.text" ||
    !sameContext(assistant, contextId) ||
    assistant.payload.mediaRequestInformationId !==
      message.requestInformationId ||
    assistant.payload.text !== message.text ||
    !isDeepStrictEqual(assistant.payload.contentSegments, message.segments)
  )
    reject();
  const requested = await input.read(message.requestInformationId);
  if (
    !requested ||
    requested.kind !== modelTaskRequestedInformationKind.kind ||
    requested.source !== "runtime:model-task" ||
    !sameContext(requested, contextId)
  )
    reject();
  const payload = modelTaskRequestedInformationKind.payloadSchema.parse(
    requested.payload,
  );
  if (
    payload.taskId !== "agent.heavy.respond" ||
    payload.outputMode !== "object" ||
    payload.inputBlocked ||
    payload.contextInformationId !== contextId ||
    payload.activation.definitionId !== "agent.heavy" ||
    payload.activation.instanceId !==
      assistant.payload.originatingModuleInstanceId
  )
    reject();
  const completed = await completedFor(
    assistant,
    requested.informationId,
    contextId,
    input.read,
    signal,
  );
  const completion = modelTaskCompletedInformationKind.payloadSchema.parse(
    completed.payload,
  );
  for (const relation of ["core:caused-by", "core:status-of"]) {
    const refs = completed.references.filter((r) => r.relation === relation);
    if (refs.length !== 1 || refs[0]!.informationId !== requested.informationId)
      reject();
  }
  if (
    completion.generationKind !== "final" ||
    completion.toolCalls.length ||
    completion.taskId !== payload.taskId ||
    completion.outputMode !== "object" ||
    completion.sourceInformationId !== payload.sourceInformationId ||
    completion.contextInformationId !== contextId ||
    !isDeepStrictEqual(completion.activation, payload.activation)
  )
    reject();
  const output = completion.output;
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    output.action !== "message" ||
    output.text !== message.text ||
    !isDeepStrictEqual(output.contentSegments, message.segments)
  )
    reject();
  validateOutboundMediaSelection(
    message.text,
    message.segments,
    payload.messages,
  );
  const scope = sceneIdentity(input.target);
  const key = payload.nativeStep
    ? `media-run:${payload.nativeStep.runInformationId}`
    : modelTaskFingerprint(payload);
  const snapshot = await input.readSnapshot(key, scope);
  if (!Array.isArray(snapshot) || !Array.isArray(payload.messages)) reject();
  const allowed = frozenOutboundMediaIds(snapshot);
  const ids = [
    ...new Set(
      message.segments.flatMap((s) =>
        s.kind === "mediaRef" ? [s.mediaId] : [],
      ),
    ),
  ];
  let total = 0;
  const images: Array<Images[number]> = [];
  for (const mediaId of ids) {
    signal?.throwIfAborted();
    if (!allowed.has(mediaId)) reject();
    const frozen = snapshot.find((entry) =>
      frozenOutboundMediaIds([entry]).has(mediaId),
    );
    if (
      !frozen ||
      !payload.messages.some((entry) => isDeepStrictEqual(entry, frozen))
    )
      reject();
    const marker = JSON.parse(
      (frozen as { content: { text: string }[] }).content[0]!.text,
    ).mediaInput;
    const source = await input.readSource(mediaId, scope);
    if (
      !source ||
      source.mediaId !== mediaId ||
      source.status !== "available" ||
      source.resourceId !== marker.resourceId ||
      !source.resourceId ||
      !source.mimeType
    )
      reject();
    const resource = await input.resources?.get(source.resourceId);
    signal?.throwIfAborted();
    if (
      !resource ||
      resource.resourceId !== source.resourceId ||
      resource.mimeType !== source.mimeType ||
      resource.bytes.byteLength !== source.byteLength ||
      resource.bytes.byteLength < 1 ||
      resource.bytes.byteLength > 10 * 1024 * 1024 ||
      imageMime(resource.bytes) !== source.mimeType
    )
      reject();
    const sha256 = createHash("sha256").update(resource.bytes).digest("hex");
    if (
      resource.sha256 !== sha256 ||
      resource.resourceId !== `sha256:${sha256}`
    )
      reject();
    total +=
      resource.bytes.byteLength *
      message.segments.filter(
        (s) => s.kind === "mediaRef" && s.mediaId === mediaId,
      ).length;
    if (total > 20 * 1024 * 1024) reject();
    images.push({
      mediaId,
      bytes: Uint8Array.from(resource.bytes),
      mimeType: source.mimeType,
      sha256,
    });
  }
  signal?.throwIfAborted();
  return images;
}
