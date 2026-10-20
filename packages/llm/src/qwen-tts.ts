/**
 * 功能概述：通过 Qwen 非实时 HTTP 接口合成 WAV，并下载到有界内存。
 * 主要职责：统一区域、超时与取消，校验音频结构，屏蔽凭据和供应商原始错误。
 * 代码库关系：实现 TtsProvider；不依赖平台适配器，不自动重试或创建音色。
 * 输入输出与副作用：一次合成 POST 和一次音频 GET；返回音频供宿主持久化。
 */
import { createHash } from "node:crypto";
import { TtsError, type TtsIdentity, type TtsProvider } from "./tts.js";

export interface QwenTtsOptions {
  readonly identity: TtsIdentity;
  readonly apiKey: string;
  /** 运营方确认的 OSS 主机名，必须为精确主机名，不能是 URL、通配符或 IP。 */
  readonly audioHosts: readonly string[];
  readonly timeoutMs?: number;
  readonly maxAudioBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const endpoints = {
  beijing: "https://dashscope.aliyuncs.com",
  singapore: "https://dashscope-intl.aliyuncs.com",
} as const;
const languages = new Set([
  "Auto",
  "Chinese",
  "English",
  "German",
  "Italian",
  "Portuguese",
  "Spanish",
  "Japanese",
  "Korean",
  "French",
  "Russian",
]);

export function createQwenTtsProvider(options: QwenTtsOptions): TtsProvider {
  const identity = Object.freeze({ ...options.identity });
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxAudioBytes ?? 10 * 1024 * 1024;
  const hosts = new Set(options.audioHosts);
  if (
    identity.provider !== "qwen" ||
    !endpoints[identity.region] ||
    !identity.accountScope.trim() ||
    !identity.model.trim() ||
    !identity.voice.trim() ||
    !languages.has(identity.language) ||
    !options.apiKey.trim() ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 44 ||
    maxBytes > 50 * 1024 * 1024 ||
    hosts.size === 0 ||
    [...hosts].some(
      (host) => !/^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/u.test(host),
    )
  )
    throw new TtsError("invalid_configuration");
  const fetcher = options.fetch ?? globalThis.fetch;
  // 秘密只留在闭包，不出现在 provider 的可枚举身份中。
  const apiKey = options.apiKey;
  return Object.freeze({
    identity,
    async synthesize(text: string, signal: AbortSignal) {
      if (!text.trim() || Array.from(text).length > 600)
        throw new TtsError("invalid_text");
      if (signal.aborted) throw new TtsError("cancelled");
      const controller = new AbortController();
      const cancel = () => controller.abort(new TtsError("cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(
        () => controller.abort(new TtsError("timeout")),
        timeoutMs,
      );
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const run = async () => {
        let response: Response;
        try {
          response = await fetcher(
            `${endpoints[identity.region]}/api/v1/services/aigc/multimodal-generation/generation`,
            {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: identity.model,
                input: {
                  text,
                  voice: identity.voice,
                  language_type: identity.language,
                },
              }),
            },
          );
        } catch {
          throw new TtsError("provider_unavailable");
        }
        controller.signal.throwIfAborted();
        if (!response.ok) {
          await response.body?.cancel();
          throw new TtsError("provider_rejected");
        }
        let url: URL;
        let providerCharacters: number | undefined;
        try {
          const body = JSON.parse(
            new TextDecoder().decode(
              await readBounded(response, 64 * 1024, controller.signal),
            ),
          );
          if (
            Number.isSafeInteger(body.usage?.characters) &&
            body.usage.characters >= 0
          )
            providerCharacters = body.usage.characters;
          url = new URL(body.output.audio.url);
          if (
            (body.code && body.code !== "") ||
            (body.status_code !== undefined && body.status_code !== 200) ||
            !hosts.has(url.hostname) ||
            url.username ||
            url.password ||
            url.port ||
            !["http:", "https:"].includes(url.protocol)
          )
            throw new Error();
          // 官方旧响应示例使用 HTTP 签名 URL；仅对已明确允许的 OSS 主机升级 HTTPS。
          url.protocol = "https:";
        } catch {
          throw new TtsError("invalid_response");
        }
        controller.signal.throwIfAborted();
        let audio: Response;
        try {
          audio = await fetcher(url, {
            signal: controller.signal,
            redirect: "error",
          });
        } catch {
          throw new TtsError("download_failed");
        }
        controller.signal.throwIfAborted();
        if (!audio.ok) {
          await audio.body?.cancel();
          throw new TtsError("download_failed");
        }
        let bytes: Uint8Array;
        try {
          bytes = await readBounded(audio, maxBytes, controller.signal);
        } catch (error) {
          if (error instanceof TtsError) throw error;
          throw new TtsError("download_failed");
        }
        controller.signal.throwIfAborted();
        const durationMs = wavDuration(bytes);
        return {
          bytes,
          mimeType: "audio/wav" as const,
          durationMs,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          synthesizedText: text,
          ...(providerCharacters === undefined ? {} : { providerCharacters }),
        };
      };
      try {
        return await Promise.race([run(), aborted]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
  });
}

export async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new TtsError("audio_too_large");
  }
  if (!response.body) throw new TtsError("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) throw new TtsError("audio_too_large");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 首版只接受完整 PCM WAV；不把 HTML、压缩音频或截断文件交给平台。 */
function wavDuration(bytes: Uint8Array): number {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => {
    throw new TtsError("invalid_audio");
  };
  if (
    data.length < 44 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WAVE" ||
    data.readUInt32LE(4) + 8 !== data.length
  )
    invalid();
  let byteRate = 0;
  let blockAlign = 0;
  let audioBytes = 0;
  let offset = 12;
  for (; offset + 8 <= data.length;) {
    const kind = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size + (size % 2) > data.length) invalid();
    if (kind === "fmt ") {
      if (byteRate || size < 16 || data.readUInt16LE(start) !== 1) invalid();
      const channels = data.readUInt16LE(start + 2);
      const rate = data.readUInt32LE(start + 4);
      byteRate = data.readUInt32LE(start + 8);
      blockAlign = data.readUInt16LE(start + 12);
      const bits = data.readUInt16LE(start + 14);
      if (
        ![1, 2].includes(channels) ||
        rate < 8000 ||
        rate > 192000 ||
        ![8, 16, 24, 32].includes(bits) ||
        blockAlign !== (channels * bits) / 8 ||
        byteRate !== rate * blockAlign
      )
        invalid();
    } else if (kind === "data") {
      if (!byteRate || audioBytes || !size || size % blockAlign) invalid();
      audioBytes = size;
    }
    offset = start + size + (size % 2);
  }
  if (offset !== data.length || !byteRate || !audioBytes) invalid();
  return (audioBytes / byteRate) * 1000;
}
