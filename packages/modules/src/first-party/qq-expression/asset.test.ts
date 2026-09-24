/** QQ 素材边界测试：受控网络替身验证地址、大小、文件格式以及缓存副本。 */
import { describe, expect, it, vi } from "vitest";
import { cacheQqSticker } from "./asset.js";
describe("QQ sticker asset cache", () => {
  it("rejects arbitrary hosts and paths without fetching", async () => {
    const fetcher = vi.fn();
    for (const url of [
      "file:///etc/passwd",
      "http://127.0.0.1",
      "https://qpic.cn.attacker.test/x",
      "https://qpic.cn:444/x",
      "https://user@qpic.cn/x",
    ])
      expect(await cacheQqSticker(url, fetcher)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("persists only bounded supported image bytes and disallows redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(Buffer.from("GIF89a123456")),
    );
    expect(await cacheQqSticker("https://gchat.qpic.cn/x", fetcher)).toBe(
      "base64://R0lGODlhMTIzNDU2",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(
      await cacheQqSticker(
        "https://gchat.qpic.cn/x",
        async () => new Response("<html>login</html>"),
      ),
    ).toBeUndefined();
    expect(
      await cacheQqSticker(
        "https://gchat.qpic.cn/x",
        async () => new Response(new Uint8Array(512 * 1024 + 1)),
      ),
    ).toBeUndefined();
  });
});

it("accepts the current QQ multimedia CDN hostname", async () => {
  expect(
    await cacheQqSticker(
      "https://multimedia.nt.qq.com.cn/download?fileid=synthetic",
      async () => new Response(Buffer.from("GIF89a123456")),
    ),
  ).toBe("base64://R0lGODlhMTIzNDU2");
});
