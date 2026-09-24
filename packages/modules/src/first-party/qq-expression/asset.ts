/**
 * 功能概述：仅为 QQ 表情插件下载受信 QQ CDN 图片，收藏副本避免临时 URL 失效。
 * cacheQqSticker 限制 HTTPS 主机、端口、重定向、超时、字节数与文件魔数；不访问用户给定本地路径。
 * 返回可直接交给 NapCat 的 base64 素材；失败返回 undefined，插件不依赖图片识别能力。
 * fetch 可注入替身做离线测试；下载内容只落插件账本，绝不进入模型上下文。
 */
export async function cacheQqSticker(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const maxBytes = 512 * 1024;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !(
        parsed.hostname === "multimedia.nt.qq.com" ||
        parsed.hostname === "multimedia.nt.qq.com.cn" ||
        parsed.hostname === "qpic.cn" ||
        parsed.hostname.endsWith(".qpic.cn")
      )
    )
      return undefined;
    const response = await fetcher(parsed, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) > maxBytes
    ) {
      await response.body?.cancel();
      return undefined;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    const valid =
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")) ||
      (bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP");
    return valid ? `base64://${bytes.toString("base64")}` : undefined;
  } catch {
    return undefined;
  }
}
