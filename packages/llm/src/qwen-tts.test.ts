/**
 * 功能概述：验证 Qwen TTS 请求、音频边界和取消行为。
 * 主要职责：使用内存 transport 覆盖错误脱敏、受限下载和迟到响应。
 * 代码库关系：与 qwen-tts.ts、tts.ts 配套，不需要真实凭据。
 * 输入输出与副作用：不访问网络，不产生付费合成或平台投递。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQwenTtsProvider } from "./qwen-tts.js";
import { ttsTaskKey, type TtsIdentity } from "./tts.js";

const host = "dashscope-result-bj.oss-cn-beijing.aliyuncs.com";
const identity: TtsIdentity = {
  provider: "qwen",
  accountScope: "test-account",
  region: "beijing",
  model: "qwen3-tts-vc-2026-01-22",
  voice: "test-only-voice",
  language: "Chinese",
};
function wav() {
  const data = Buffer.alloc(48);
  data.write("RIFF");
  data.writeUInt32LE(40, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(4, 40);
  return data;
}
const result = (url = `https://${host}/test.wav?Signature=private`) =>
  Response.json({ output: { audio: { url } } });
function fixture(
  responses: Response[],
  options: { timeoutMs?: number; maxAudioBytes?: number } = {},
) {
  const fetcher = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("private-provider-error");
    return next;
  });
  const provider = createQwenTtsProvider({
    identity,
    apiKey: "test-only-secret",
    audioHosts: [host],
    fetch: fetcher,
    ...options,
  });
  return { provider, fetcher };
}
afterEach(() => vi.useRealTimers());

describe("Qwen TTS provider", () => {
  it("preserves only valid reported character usage", async () => {
    const { provider } = fixture([
      Response.json({
        output: { audio: { url: `https://${host}/sample.wav` } },
        usage: { characters: 2, private: "ignored" },
      }),
      new Response(wav()),
    ]);
    const audio = await provider.synthesize(
      "你好",
      new AbortController().signal,
    );
    expect(audio.providerCharacters).toBe(2);
    expect(JSON.stringify(audio)).not.toContain("ignored");
  });
  it("rejects invalid configuration before network access", () => {
    for (const change of [
      { apiKey: " " },
      { audioHosts: ["*.aliyuncs.com"] },
      { audioHosts: ["127.0.0.1"] },
      { timeoutMs: 0 },
      { maxAudioBytes: 100 * 1024 * 1024 },
    ]) {
      expect(() =>
        createQwenTtsProvider({
          identity,
          apiKey: "test-only-secret",
          audioHosts: [host],
          ...change,
        }),
      ).toThrow("TTS invalid_configuration");
    }
  });
  it("bounds malformed JSON and redacts download failures", async () => {
    for (const responses of [
      [new Response("invalid-json")],
      [Response.json({ code: "bad", message: "test-only-secret" })],
      [new Response("x".repeat(65537))],
    ]) {
      const { provider } = fixture(responses);
      await expect(
        provider.synthesize("你好", new AbortController().signal),
      ).rejects.toThrow("TTS invalid_response");
    }
    const { provider } = fixture([
      result(),
      new Response("test-only-secret", { status: 403 }),
    ]);
    await expect(
      provider.synthesize("你好", new AbortController().signal),
    ).rejects.toThrow("TTS download_failed");
  });
  it("cancels a stalled audio stream when the total deadline expires", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        started.resolve();
      },
      cancel,
    });
    const { provider } = fixture([result(), new Response(stream)], {
      timeoutMs: 100,
    });
    const pending = provider.synthesize("你好", new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({
      code: "timeout",
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("preserves approved text and only sends credentials to the configured region", async () => {
    const { provider, fetcher } = fixture([
      result(`http://${host}/test.wav`),
      new Response(wav()),
    ]);
    const text = "  你好\n";
    const audio = await provider.synthesize(text, new AbortController().signal);
    expect(audio).toMatchObject({
      synthesizedText: text,
      mimeType: "audio/wav",
      bytes: wav(),
    });
    expect(audio.durationMs).toBeCloseTo((4 / 48000) * 1000);
    expect(audio.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(JSON.parse(init!.body as string)).toEqual({
      model: identity.model,
      input: { text, voice: identity.voice, language_type: "Chinese" },
    });
    expect(fetcher.mock.calls[1]![0].toString()).toBe(
      `https://${host}/test.wav`,
    );
    expect(fetcher.mock.calls[1]![1]!.headers).toBeUndefined();
    expect(JSON.stringify(provider)).not.toContain("test-only-secret");
  });
  it.each(["", "字".repeat(601)])(
    "rejects invalid text before spending",
    async (text) => {
      const { provider, fetcher } = fixture([]);
      await expect(
        provider.synthesize(text, new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid_text" });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([401, 429, 500])(
    "does not retry HTTP %s or expose its body",
    async (status) => {
      const { provider, fetcher } = fixture([
        new Response("test-only-secret", { status }),
      ]);
      await expect(
        provider.synthesize("你好", new AbortController().signal),
      ).rejects.toThrow("TTS provider_rejected");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "http://127.0.0.1/secret",
    "file:///secret",
    "https://evil.invalid/x",
    `https://${host}.evil.invalid/x`,
    `https://user:password@${host}/x`,
    `https://${host}:8080/x`,
  ])("rejects untrusted download URL %s", async (url) => {
    const { provider, fetcher } = fixture([result(url)]);
    await expect(
      provider.synthesize("你好", new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([Buffer.from("<html>not audio</html>"), wav().subarray(0, 46)])(
    "rejects invalid or truncated WAV",
    async (data) => {
      const { provider } = fixture([result(), new Response(data)]);
      await expect(
        provider.synthesize("你好", new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid_audio" });
    },
  );
  it.each([true, false])(
    "limits downloads even without content-length (%s)",
    async (header) => {
      const { provider } = fixture(
        [
          result(),
          new Response(wav(), {
            headers: header ? { "Content-Length": "48" } : {},
          }),
        ],
        { maxAudioBytes: 44 },
      );
      await expect(
        provider.synthesize("你好", new AbortController().signal),
      ).rejects.toMatchObject({ code: "audio_too_large" });
    },
  );
  it("cancels before dispatch", async () => {
    const { provider, fetcher } = fixture([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.synthesize("你好", controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["timeout", "cancelled"] as const)(
    "ignores a late synthesis response after %s",
    async (code) => {
      vi.useFakeTimers();
      const response = Promise.withResolvers<Response>();
      const fetcher = vi.fn<typeof fetch>(() => response.promise);
      const provider = createQwenTtsProvider({
        identity,
        apiKey: "test-only-secret",
        audioHosts: [host],
        fetch: fetcher,
        timeoutMs: 100,
      });
      const controller = new AbortController();
      const pending = provider.synthesize("你好", controller.signal);
      const assertion = expect(pending).rejects.toMatchObject({ code });
      if (code === "timeout") await vi.advanceTimersByTimeAsync(100);
      else controller.abort();
      await assertion;
      response.resolve(result());
      await vi.runAllTimersAsync();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("uses stable task keys with account, source and synthesis parameters isolated", () => {
    const key = ttsTaskKey("source-a", "你好", identity);
    expect(ttsTaskKey("source-a", "你好", { ...identity })).toBe(key);
    expect(ttsTaskKey("source-b", "你好", identity)).not.toBe(key);
    expect(ttsTaskKey("source-a", "您好", identity)).not.toBe(key);
    for (const changed of [
      { voice: "other" },
      { language: "Auto" },
      { model: "other" },
      { accountScope: "other" },
      { region: "singapore" as const },
    ])
      expect(
        ttsTaskKey("source-a", "你好", { ...identity, ...changed }),
      ).not.toBe(key);
  });
});
