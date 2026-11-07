/**
 * 功能概述：连接已授权入站、媒体来源索引与 Heavy 三档实际输入；不依赖 Memory 模块。
 * ingestMediaContent 在消息入账前保存稳定引用；来源获取由宿主显式注入，无默认 URL/文件读取。
 * prepareHeavyMedia 仅在新 Heavy 请求执行，按 scope 核验引用并冻结标记、图像或已完成视觉观察。
 * original 字节复用 SDK MediaResourceStore；默认 Sharp 验证与均匀抽帧，external 观察由受控宿主提供，
 * 观察回调必须以给定 key 复用持久 ModelTask，不承诺外部请求 exactly-once。旧快照不再次回调。
 * 输入元信息不携带临时 URL；所有预算独立于文本。失败保留不可见状态，绝不切换模式。
 * PNG 动画按真实 chunk 识别；自定义抽帧保持 MIME、时间顺序和字节预算。帧验证通过后、
 * 尝试视觉调用前计入本轮预算，失败的外部请求不退款，避免后续调用突破总媒体输入上限。
 */
import { validateMediaImage, decodeMediaFrames } from "./image-decoder.js";
import { createHash } from "node:crypto";
import { PostgresMediaSourceStore } from "@kaguya/database";
import type { MediaResourceStore } from "@kaguya/sdk";
import {
  mediaContentSegmentsSchema,
  sceneIdentity,
  type MediaContentSegment,
  type MediaReference,
  type NativeMessage,
  type DeepReadonly,
  type InformationAtom,
  type JsonValue,
} from "@kaguya/schema";
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
type IncomingMedia = Extract<
  NonNullable<PlatformInboundMessage["contentSegments"]>[number],
  { kind: "media" }
>;
export interface MediaFrame {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly atMs: number;
}
export interface MediaInputOptions {
  readonly mode: "off" | "native" | "external";
  /** 宿主在 adapter 授权后提供有大小限制的素材读取，必须遵守 signal；不得解析任意路径。 */
  readonly acquire?: (
    segment: IncomingMedia,
    input: PlatformInboundMessage,
    signal: AbortSignal,
  ) => Promise<Uint8Array | undefined>;
  readonly decodeAnimation?: (
    bytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<readonly MediaFrame[]>;
  /** 原生图像能力按 Heavy 的具体模型配置显式批准。 */
  readonly nativeModel?: {
    readonly providerId: string;
    readonly modelId: string;
  };
  /** 必须读取或执行受控持久 ModelTask；返回真实完成时间及模型身份，不能把描述当原文。 */
  readonly observe?: (
    input: { key: string; mediaId: string; frames: readonly MediaFrame[] },
    signal: AbortSignal,
  ) => Promise<{ text: string; modelIdentity: string; completedAt: string }>;
}
export function imageMime(bytes: Uint8Array): MediaReference["mimeType"] {
  const b = Buffer.from(bytes);
  if (
    b.length >= 24 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return "image/jpeg";
  if (b.length >= 13 && /^GIF8[79]a/.test(b.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    b.length >= 16 &&
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return null;
}
/** 只沿 PNG chunk 边界查找动画控制块，不能把像素内容中的 acTL 当作动画。 */
function isAnimatedPng(bytes: Uint8Array): boolean {
  if (imageMime(bytes) !== "image/png") return false;
  const data = Buffer.from(bytes);
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) return false;
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IEND") return false;
    offset += length + 12;
  }
  return false;
}
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("media-operation-timeout"));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
export async function ingestMediaContent(
  input: PlatformInboundMessage,
  sources: PostgresMediaSourceStore,
  resources: MediaResourceStore | undefined,
  options?: MediaInputOptions,
): Promise<MediaContentSegment[] | undefined> {
  if (!input.contentSegments) return undefined;
  if (input.contentSegments.length > 256)
    throw new Error("media-segments-budget");
  const scope = sceneIdentity({
    platform: input.platform,
    adapterId: input.adapterId,
    destination: input.target,
  });
  let count = 0;
  const result: MediaContentSegment[] = [];
  for (const part of input.contentSegments) {
    if (part.kind === "text") {
      result.push({ kind: "text", text: part.text });
      continue;
    }
    const sourceKey = JSON.stringify([
      input.platformMessageId,
      input.sender.userId,
      input.selfId ?? null,
      part.position,
    ]);
    const mediaId = `media:${hash(JSON.stringify([scope, sourceKey]))}`;
    const existing = await sources.read(mediaId, scope);
    if (existing) {
      result.push({ kind: "media", media: existing });
      count++;
      continue;
    }
    let media: MediaReference = {
      mediaId,
      position: part.position,
      mediaType: part.mediaType,
      status: count++ >= 4 ? "omitted" : "unavailable",
      resourceId: null,
      mimeType: null,
      byteLength: 0,
    };
    if (media.status !== "omitted" && resources && options?.acquire) {
      try {
        const bytes = await bounded(
          (signal) => options.acquire!(part, input, signal),
          5_000,
        );
        if (bytes) {
          const mimeType = imageMime(bytes);
          if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES || !mimeType)
            media = { ...media, status: "invalid" };
          else {
            await bounded((signal) => validateMediaImage(bytes, signal), 5_000);
            const sha256 = hash(bytes),
              resourceId = `sha256:${sha256}`;
            await resources.put({ resourceId, bytes, mimeType, sha256 });
            media = {
              ...media,
              status: "available",
              resourceId,
              mimeType,
              byteLength: bytes.byteLength,
            };
          }
        }
      } catch {
        media = { ...media, status: "unavailable" };
      }
    }
    result.push({
      kind: "media",
      media: await sources.put(scope, sourceKey, media),
    });
  }
  return mediaContentSegmentsSchema.parse(result);
}
/** 从所选账本原消息与冻结情境提取引用；不扫描模型输出或任意嵌套 JSON。 */
export function selectedMedia(
  atoms: readonly DeepReadonly<InformationAtom>[],
): MediaReference[] {
  const result = new Map<string, MediaReference>();
  const add = (value: unknown) => {
    const parsed = mediaContentSegmentsSchema.safeParse(value);
    if (parsed.success)
      for (const s of parsed.data)
        if (s.kind === "media") result.set(s.media.mediaId, s.media);
  };
  // 当前冻结情境优先于历史，再纳入直接选中的原消息；每个引用只占一次预算。
  for (const atom of atoms) {
    if (atom.kind !== "agent.situation.frozen") continue;
    const frame = atom.payload.frame as
      { current?: { evidence?: { contentSegments?: unknown }[] } } | undefined;
    for (const e of frame?.current?.evidence ?? []) add(e.contentSegments);
  }
  for (const atom of atoms)
    if (atom.kind === "core.message.inbound.text")
      add(atom.payload.contentSegments);
  for (const atom of atoms) {
    if (atom.kind !== "agent.situation.frozen") continue;
    const frame = atom.payload.frame as
      | { background?: { evidence?: { contentSegments?: unknown }[] } }
      | undefined;
    for (const e of frame?.background?.evidence ?? []) add(e.contentSegments);
  }
  return [...result.values()];
}
export async function prepareHeavyMedia(input: {
  key: string;
  scope: string;
  refs: readonly MediaReference[];
  model: { providerId: string; modelId: string };
  sources: PostgresMediaSourceStore;
  resources: MediaResourceStore | undefined;
  options?: MediaInputOptions;
}): Promise<NativeMessage[]> {
  if (!input.refs.length) return [];
  return (await input.sources.freeze(input.key, input.scope, async () => {
    const options = input.options ?? { mode: "off" as const };
    if (
      options.mode === "native" &&
      (options.nativeModel?.providerId !== input.model.providerId ||
        options.nativeModel?.modelId !== input.model.modelId)
    )
      throw new Error("media-native-model-unapproved");
    const messages: NativeMessage[] = [];
    let usedBytes = 0;
    for (const [index, ref] of input.refs.entries()) {
      const origin = await input.sources.read(ref.mediaId, input.scope);
      let status: string =
        index >= 4 ? "omitted" : (origin?.status ?? "unauthorized");
      const parts: JsonValue[] = [];
      let observation:
        | { text: string; modelIdentity: string; completedAt: string }
        | undefined;
      let frameManifest: { sha256: string; atMs: number }[] = [];
      if (status === "available" && options.mode === "off")
        status = "vision-off";
      if (status === "available" && options.mode !== "off") {
        try {
          const resource = origin?.resourceId
            ? await input.resources?.get(origin.resourceId)
            : undefined;
          if (
            !resource ||
            resource.bytes.byteLength > MAX_BYTES ||
            resource.resourceId !== origin?.resourceId ||
            `sha256:${hash(resource.bytes)}` !== origin.resourceId ||
            resource.bytes.byteLength !== origin.byteLength ||
            imageMime(resource.bytes) !== origin.mimeType
          )
            throw new Error("resource-unavailable");
          if (usedBytes + resource.bytes.byteLength > MAX_INPUT_BYTES) {
            status = "omitted";
          } else {
            const apng = isAnimatedPng(resource.bytes);
            const animated =
              apng ||
              origin.mimeType === "image/gif" ||
              (origin.mimeType === "image/webp" &&
                Buffer.from(resource.bytes).includes(Buffer.from("ANIM")));
            const frames: readonly MediaFrame[] = animated
              ? await bounded(
                  (signal) =>
                    (options.decodeAnimation ?? decodeMediaFrames)(
                      resource.bytes,
                      signal,
                    ),
                  5_000,
                )
              : [
                  {
                    bytes: resource.bytes,
                    mimeType: origin.mimeType as
                      "image/png" | "image/jpeg" | "image/webp",
                    atMs: 0,
                  },
                ];
            if (
              !frames.length ||
              frames.length > 4 ||
              (apng && frames.length < 2)
            )
              throw new Error("animation-not-decoded");
            let previous = -1;
            let frameBytes = 0;
            for (const frame of frames) {
              if (
                !Number.isFinite(frame.atMs) ||
                frame.atMs < 0 ||
                frame.atMs <= previous ||
                imageMime(frame.bytes) !== frame.mimeType ||
                frame.bytes.byteLength < 1 ||
                frame.bytes.byteLength > MAX_BYTES ||
                usedBytes + frameBytes + frame.bytes.byteLength >
                  MAX_INPUT_BYTES
              )
                throw new Error("frame-invalid-or-budget");
              previous = frame.atMs;
              frameBytes += frame.bytes.byteLength;
              frameManifest.push({
                sha256: hash(frame.bytes),
                atMs: frame.atMs,
              });
            }
            usedBytes += frameBytes;
            if (options.mode === "native") {
              for (const frame of frames)
                parts.push({
                  type: "file",
                  data: {
                    type: "data",
                    data: Buffer.from(frame.bytes).toString("base64"),
                  },
                  mediaType: frame.mimeType,
                });
              status = "native";
            } else if (options.observe) {
              observation = await bounded(
                (signal) =>
                  options.observe!(
                    {
                      key: `${input.key}:${ref.mediaId}`,
                      mediaId: ref.mediaId,
                      frames,
                    },
                    signal,
                  ),
                30_000,
              );
              if (
                !observation.text ||
                observation.text.length > 16_000 ||
                !observation.modelIdentity ||
                !Number.isFinite(Date.parse(observation.completedAt))
              )
                throw new Error("observation-invalid");
              status = "external";
            } else status = "vision-unavailable";
          }
        } catch {
          status = "vision-unavailable";
          observation = undefined;
          frameManifest = [];
          parts.length = 0;
        }
      }
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mediaInput: {
                mediaId: ref.mediaId,
                position: ref.position,
                mode: options.mode,
                status,
                resourceId: origin?.resourceId ?? null,
                frames: frameManifest,
                ...(observation
                  ? {
                      observation: {
                        ...observation,
                        evidenceRole: "derived-visual-observation",
                      },
                    }
                  : {}),
              },
            }),
          },
          ...parts,
        ],
      });
    }
    return messages as JsonValue[];
  })) as NativeMessage[];
}

/** 工具文字历史先移除宿主媒体块；本次请求会从 run 的同一冻结快照重新附加，保留全部调用/结果。 */
export function withoutFrozenMediaInput(
  messages: readonly NativeMessage[],
): NativeMessage[] {
  return messages.filter((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return true;
    const first = message.content[0];
    if (
      !first ||
      typeof first !== "object" ||
      Array.isArray(first) ||
      first.type !== "text" ||
      typeof first.text !== "string"
    )
      return true;
    try {
      const marker = JSON.parse(first.text);
      return !(
        marker?.mediaInput &&
        /^media:[a-f0-9]{64}$/.test(marker.mediaInput.mediaId) &&
        ["off", "native", "external"].includes(marker.mediaInput.mode)
      );
    } catch {
      return true;
    }
  });
}
