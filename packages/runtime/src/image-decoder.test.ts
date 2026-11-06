/**
 * 功能概述：验证媒体解码的真实格式、动画帧顺序及取消资源清理。
 * 主要职责：使用 Sharp 生成静态 PNG/JPEG/WebP 和两帧 GIF/WebP；使用受控管线检查取消与迟到结果。
 * 代码库关系：直接测试 image-decoder，确保 media-input 可区分可用图片与明确拒绝的 APNG。
 * 输入输出与副作用：仅处理合成字节，不读取外部文件或调用网络；受控任务在测试结束前释放。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { decodeMediaFrames, validateMediaImage } from "./image-decoder.js";

const apng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAAEACgAAwQzaBAAAABFmZEFUAAAAAnicY2D4z/AfAAQBAf9i5+mcAAAAAElFTkSuQmCC",
  "base64",
);
const signal = () => new AbortController().signal;

describe("media image decoder", () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    it(`validates actual static ${format}`, async () => {
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "red" },
      })
        .toFormat(format)
        .toBuffer();
      await expect(
        validateMediaImage(bytes, signal()),
      ).resolves.toBeUndefined();
      const frames = await decodeMediaFrames(bytes, signal());
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ mimeType: "image/png", atMs: 0 });
      expect((await sharp(frames[0]!.bytes).metadata()).format).toBe("png");
    });
  }
  for (const format of ["gif", "webp"] as const) {
    it(`decodes actual animated ${format} in order`, async () => {
      const raw = Buffer.from([255, 0, 0, 0, 255, 0]);
      const bytes = await sharp(raw, {
        raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
      })
        .toFormat(format, { delay: [100, 200], loop: 0 })
        .toBuffer();
      await validateMediaImage(bytes, signal());
      const frames = await decodeMediaFrames(bytes, signal());
      expect(frames.map((frame) => frame.atMs)).toEqual([0, 100]);
      const colors = await Promise.all(
        frames.map((frame) =>
          sharp(frame.bytes).removeAlpha().raw().toBuffer(),
        ),
      );
      expect(colors[0]![0]!).toBeGreaterThan(colors[0]![1]!);
      expect(colors[1]![1]!).toBeGreaterThan(colors[1]![0]!);
    });
  }
  it("rejects APNG explicitly instead of treating its first frame as complete", async () => {
    await expect(validateMediaImage(apng, signal())).rejects.toThrow(
      "media-apng-unsupported",
    );
    await expect(decodeMediaFrames(apng, signal())).rejects.toThrow(
      "media-apng-unsupported",
    );
  });
  it("rejects corrupt data", async () => {
    await expect(
      validateMediaImage(Buffer.from("not an image"), signal()),
    ).rejects.toThrow();
  });
});

describe("decoder cancellation", () => {
  afterEach(() => {
    vi.doUnmock("sharp");
    vi.resetModules();
  });
  it("destroys the active pipeline, removes its listener and ignores late metadata", async () => {
    let release!: (metadata: {
      format: string;
      width: number;
      height: number;
    }) => void;
    const pending = new Promise<{
      format: string;
      width: number;
      height: number;
    }>((resolve) => {
      release = resolve;
    });
    const image = {
      timeout: vi.fn(),
      metadata: vi.fn(() => pending),
      png: vi.fn(),
      destroy: vi.fn(),
    };
    image.timeout.mockReturnValue(image);
    vi.resetModules();
    vi.doMock("sharp", () => ({ default: vi.fn(() => image) }));
    const decoder = await import("./image-decoder.js");
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = decoder.validateMediaImage(
      Buffer.from("image"),
      controller.signal,
    );
    try {
      expect(image.metadata).toHaveBeenCalledOnce();
      controller.abort(new Error("cancelled"));
      await expect(result).rejects.toThrow("cancelled");
      expect(image.timeout).toHaveBeenCalledWith({ seconds: 5 });
      expect(image.destroy).toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      release({ format: "png", width: 1, height: 1 });
      await pending;
      await Promise.resolve();
      expect(image.png).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      release({ format: "png", width: 1, height: 1 });
      await result.catch(() => {});
    }
  });
});
