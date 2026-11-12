/**
 * 功能概述：把持久 GUI 工具回执投影为原生 JSON 结果和原始 PNG，实时循环与历史恢复共用。
 * planNativeToolResults 先计算完整批次的序列化大小；只对被保留批次执行 materialize 读取和校验原始 blob。
 * projectNativeToolResults 供实时循环使用；核对 scope、intent、generation、归档 metadata、哈希与原图尺寸。
 * 图像放在整批 tool 结果后的 user 消息，nativeToolResultGroup 将其与完整工具交互绑定供原子裁剪。
 * 宿主 readArtifact 只读不可变 blob；本模块没有观察、输入或重新截图入口，失配时拒绝模型续轮。
 */
import { createHash } from "node:crypto";
import { nativeMessagesSchema, z, type NativeMessage } from "@kaguya/schema";
import { actionDigest } from "@kaguya/database";
import { linuxGuiTargetSchema } from "./linux-gui.js";

export type NativeArtifactReader = (input: {
  id: string;
  scope: string;
  environmentId: string;
}) => Promise<unknown>;
export interface NativeResultProjection {
  toolCallId: string;
  toolName: string;
  toolId: string;
  intentId: string | null;
  scope: string;
  value: unknown;
}
const geometry = z
  .object({
    captureId: z.string().min(1),
    coordinateFrame: z.enum(["window", "desktop"]),
    width: z.number().int().min(1).max(1280),
    height: z.number().int().min(1).max(800),
    originalWidth: z.number().int().positive(),
    originalHeight: z.number().int().positive(),
    scale: z.literal(1),
    origin: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
    target: linuxGuiTargetSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.literal("image/png"),
    capturedAt: z.iso.datetime(),
    serviceInstanceId: z.string().min(1),
    driverInstanceId: z.string().min(1),
  })
  .strict();
export interface NativeToolResultPlan {
  /** 仅供预算选择的占位消息；发送前必须 materialize。 */
  readonly messages: NativeMessage[];
  readonly byteLength: number;
  materialize(
    readArtifact?: NativeArtifactReader,
    maxBytes?: number,
  ): Promise<NativeMessage[]>;
}
/** 先按持久 metadata 计算完整批次字节数，不读取 blob，也不分配 base64 占位字符串。 */
export function planNativeToolResults(
  input: readonly NativeResultProjection[],
): NativeToolResultPlan {
  const entries: NativeResultProjection[] = JSON.parse(JSON.stringify(input));
  const content: any[] = [];
  const attachments: {
    artifact: any;
    image: z.infer<typeof geometry>;
    scope: string;
    environmentId: string;
    index: number;
  }[] = [];
  let extraBytes = 0;
  for (const entry of entries) {
    const value = entry.value as any;
    if (!["gui.observe", "gui.verify"].includes(entry.toolId)) continue;
    if (!value?.result?.image) {
      if (value?.status === "succeeded")
        throw new Error("native-image-missing");
      continue;
    }
    const parsed = geometry.safeParse(value.result.image);
    if (!parsed.success) throw new Error("native-image-geometry-invalid");
    const image = parsed.data,
      observation = value.result.observation,
      artifact = value.artifacts?.[0];
    if (
      value.artifacts?.length !== 1 ||
      !artifact ||
      artifact.scope !== entry.scope ||
      artifact.actionId !== entry.intentId ||
      artifact.generation !== observation?.generation ||
      artifact.hash !== image.sha256 ||
      artifact.mime !== image.mime ||
      typeof observation?.environmentId !== "string" ||
      !observation.environmentId ||
      image.width !== image.originalWidth ||
      image.height !== image.originalHeight ||
      image.coordinateFrame !== image.target.kind ||
      (image.target.kind === "desktop" &&
        (image.origin.x !== 0 || image.origin.y !== 0))
    )
      throw new Error("native-image-binding-invalid");
    if (
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 24 ||
      artifact.size > 16 * 1024 * 1024
    )
      throw new Error("native-image-budget");
    attachments.push({
      artifact,
      image,
      scope: entry.scope,
      environmentId: observation.environmentId,
      index: content.length + 1,
    });
    extraBytes += 4 * Math.ceil(artifact.size / 3);
    content.push(
      {
        type: "text",
        text: JSON.stringify({
          kind: "gui-original-image",
          toolCallId: entry.toolCallId,
          artifactId: artifact.id,
          observation,
          image,
        }),
      },
      {
        type: "image",
        image: "data:image/png;base64,",
        mediaType: "image/png",
      },
    );
  }
  const messages = nativeMessagesSchema.parse([
    {
      role: "tool",
      content: entries.map((e) => ({
        type: "tool-result",
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        output: { type: "json", value: e.value },
      })),
    },
    ...(content.length
      ? [
          {
            role: "user",
            nativeToolResultGroup: entries.map((e) => e.toolCallId),
            content,
          },
        ]
      : []),
  ]);
  const byteLength = Buffer.byteLength(JSON.stringify(messages)) + extraBytes;
  return {
    messages,
    byteLength,
    async materialize(readArtifact, maxBytes = 128_000) {
      if (byteLength > maxBytes) throw new Error("native-image-budget");
      if (attachments.length && !readArtifact)
        throw new Error("native-image-binding-invalid");
      const materialized: NativeMessage[] = JSON.parse(
        JSON.stringify(messages),
      );
      for (const {
        artifact,
        image,
        scope,
        environmentId,
        index,
      } of attachments) {
        let saved: any;
        try {
          saved = await readArtifact!({
            id: artifact.id,
            scope,
            environmentId,
          });
        } catch {
          throw new Error("native-image-unavailable");
        }
        if (
          !saved?.artifact ||
          actionDigest(saved.artifact) !== actionDigest(artifact) ||
          typeof saved.dataBase64 !== "string" ||
          saved.dataBase64.length > maxBytes
        )
          throw new Error("native-image-archive-mismatch");
        const bytes = Buffer.from(saved.dataBase64, "base64");
        if (
          bytes.toString("base64") !== saved.dataBase64 ||
          bytes.length !== artifact.size ||
          createHash("sha256").update(bytes).digest("hex") !== artifact.hash ||
          bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
          bytes.subarray(12, 16).toString() !== "IHDR" ||
          bytes.readUInt32BE(16) !== image.width ||
          bytes.readUInt32BE(20) !== image.height
        )
          throw new Error("native-image-integrity-failed");
        (materialized[1]!.content as any[])[index].image += saved.dataBase64;
      }
      if (Buffer.byteLength(JSON.stringify(materialized)) !== byteLength)
        throw new Error("native-image-integrity-failed");
      return materialized;
    },
  };
}
export async function projectNativeToolResults(
  entries: readonly NativeResultProjection[],
  readArtifact?: NativeArtifactReader,
  maxBytes = 128_000,
): Promise<NativeMessage[]> {
  return planNativeToolResults(entries).materialize(readArtifact, maxBytes);
}
