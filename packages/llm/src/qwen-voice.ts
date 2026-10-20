/**
 * 功能概述：Qwen-TTS 旧版非实时音色管理客户端，独立于每次回复。
 * 主要职责：创建与分页查询音色，复用合成账号及区域，不自动重试管理操作。
 * 代码库关系：管理 CLI 使用；与 Omni / Qwen-Audio 新版协议分离。
 * 输入输出与副作用：调用 customization API；不输出密钥、原始错误或参考音频。
 */
import { TtsError, type TtsIdentity } from "./tts.js";
import { readBounded } from "./qwen-tts.js";

export function createQwenVoiceManager(options: {
  readonly identity: Pick<TtsIdentity, "region" | "model">;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const { identity, apiKey } = options;
  if (
    !apiKey.trim() ||
    !["beijing", "singapore"].includes(identity.region) ||
    !identity.model.startsWith("qwen3-tts-vc-")
  )
    throw new TtsError("invalid_configuration");
  const endpoint = `https://${identity.region === "beijing" ? "dashscope" : "dashscope-intl"}.aliyuncs.com/api/v1/services/audio/tts/customization`;
  async function call(input: object): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(60000);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "qwen-voice-enrollment", input }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TtsError("provider_rejected");
      }
      const parsed = JSON.parse(
        new TextDecoder().decode(
          await readBounded(response, 256 * 1024, signal),
        ),
      );
      if (
        parsed.code ||
        !parsed.output ||
        typeof parsed.output !== "object" ||
        Array.isArray(parsed.output)
      )
        throw new TtsError("invalid_response");
      return parsed.output;
    } catch (error) {
      if (error instanceof TtsError) throw error;
      throw new TtsError(signal.aborted ? "timeout" : "provider_unavailable");
    }
  }
  return {
    async create(name: string, wav: Uint8Array): Promise<string> {
      if (
        !/^[a-zA-Z0-9_]{1,16}$/u.test(name) ||
        wav.length < 44 ||
        wav.length > 10 * 1024 * 1024 ||
        Buffer.from(wav.subarray(0, 4)).toString() !== "RIFF" ||
        Buffer.from(wav.subarray(8, 12)).toString() !== "WAVE"
      )
        throw new TtsError("invalid_audio");
      const output = await call({
        action: "create",
        target_model: identity.model,
        preferred_name: name,
        audio: {
          data: `data:audio/wav;base64,${Buffer.from(wav).toString("base64")}`,
        },
      });
      if (typeof output.voice !== "string" || !output.voice)
        throw new TtsError("invalid_response");
      return output.voice;
    },
    async list(page = 0): Promise<{ voice: string; targetModel: string }[]> {
      if (!Number.isSafeInteger(page) || page < 0)
        throw new TtsError("invalid_configuration");
      const output = await call({
        action: "list",
        page_size: 100,
        page_index: page,
      });
      if (!Array.isArray(output.voice_list))
        throw new TtsError("invalid_response");
      return output.voice_list.map((item: unknown) => {
        if (
          !item ||
          typeof item !== "object" ||
          !("voice" in item) ||
          typeof item.voice !== "string" ||
          !("target_model" in item) ||
          typeof item.target_model !== "string"
        )
          throw new TtsError("invalid_response");
        return { voice: item.voice, targetModel: item.target_model };
      });
    },
  };
}
