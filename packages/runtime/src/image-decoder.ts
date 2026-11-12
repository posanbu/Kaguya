/**
 * 功能概述：在独立像素和时间预算下验证图片、为 GIF/WebP 动图抽帧；原件仍由媒体仓储保留。
 * 主要职责：validateMediaImage 验证格式和首帧；decodeMediaFrames 按累计时长选取至多四帧。
 * 代码库关系：media-input 使用本模块准备模型输入；本模块不下载素材或调用模型。
 * 输入输出与副作用：输入字节及取消信号，输出 PNG 帧和时间点；取消或结束时销毁 Sharp 管线。
 * APNG 明确拒绝，防止仅把首帧误认为完整动画；libvips 超时和取消不承诺立即中断原生计算。
 */
import sharp, { type Sharp } from "sharp";
import type { MediaFrame } from "./media-input.js";

const pixels = 16_000_000;
const supported = new Set(["png", "jpeg", "gif", "webp"]);

function rejectApng(bytes: Uint8Array): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return;
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) break;
    const kind = data.toString("ascii", offset + 4, offset + 8);
    if (kind === "acTL") throw new Error("media-apng-unsupported");
    if (kind === "IDAT" || kind === "IEND") break;
    offset += length + 12;
  }
}

async function withDecoder<T>(
  bytes: Uint8Array,
  page: number,
  signal: AbortSignal,
  operation: (image: Sharp) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const image = sharp(bytes, {
    page,
    pages: 1,
    limitInputPixels: pixels,
    failOn: "error",
  }).timeout({ seconds: 5 });
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    image.destroy();
    rejectAbort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([operation(image), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    image.destroy();
  }
}

export async function validateMediaImage(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  rejectApng(bytes);
  await withDecoder(bytes, 0, signal, async (image) => {
    const metadata = await image.metadata();
    if (
      !metadata.format ||
      !supported.has(metadata.format) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * (metadata.pageHeight ?? metadata.height) > pixels ||
      (metadata.pages ?? 1) > 200
    )
      throw new Error("media-image-invalid");
    signal.throwIfAborted();
    await image.png().toBuffer();
    signal.throwIfAborted();
  });
}

export async function decodeMediaFrames(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<readonly MediaFrame[]> {
  rejectApng(bytes);
  const metadata = await withDecoder(bytes, 0, signal, (image) =>
    image.metadata(),
  );
  const pages = metadata.pages ?? 1;
  if (
    !metadata.format ||
    !supported.has(metadata.format) ||
    !metadata.width ||
    !metadata.height ||
    metadata.width * (metadata.pageHeight ?? metadata.height) > pixels ||
    pages < 1 ||
    pages > 200
  )
    throw new Error("media-animation-invalid");
  const times: number[] = [0];
  for (let i = 1; i < pages; i++)
    times.push(times[i - 1]! + Math.max(10, metadata.delay?.[i - 1] ?? 100));
  const selected = new Set<number>([0, pages - 1]);
  for (let i = 1; i < Math.min(4, pages) - 1; i++) {
    const target = (times.at(-1)! * i) / (Math.min(4, pages) - 1);
    let best = 0;
    for (let n = 1; n < pages; n++)
      if (Math.abs(times[n]! - target) < Math.abs(times[best]! - target))
        best = n;
    selected.add(best);
  }
  const frames: MediaFrame[] = [];
  for (const page of [...selected].sort((a, b) => a - b)) {
    const png = await withDecoder(bytes, page, signal, (image) =>
      image.png().toBuffer(),
    );
    frames.push({ bytes: png, mimeType: "image/png", atMs: times[page]! });
  }
  return frames;
}
