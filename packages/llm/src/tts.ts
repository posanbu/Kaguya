/**
 * 功能概述：定义语音合成的窄接口与可持久化任务标识。
 * 主要职责：分离合成参数、凭据与内存音频，提供脱敏错误和稳定任务键。
 * 代码库关系：Qwen provider 实现此端口；后续 TTS 模块负责产物存储和投递事件。
 * 输入输出与副作用：此文件不访问网络，不发送平台消息，不承诺供应商幂等。
 */
import { createHash } from "node:crypto";

export interface TtsIdentity {
  readonly provider: "qwen";
  /** 非秘密账号标识，避免跨账号复用音色或产物；不得填入 API key。 */
  readonly accountScope: string;
  readonly region: "beijing" | "singapore";
  readonly model: string;
  readonly voice: string;
  readonly language: string;
}

export interface TtsAudio {
  /** 仅用于交给资源存储；禁止把 bytes 写入 InformationAtom。 */
  readonly bytes: Uint8Array;
  readonly mimeType: "audio/wav";
  readonly sha256: string;
  readonly durationMs: number;
  readonly synthesizedText: string;
  /** 仅当供应商实际返回有效计数字段时设置；未返回不能解释为零。 */
  readonly providerCharacters?: number;
}

export interface TtsProvider {
  readonly identity: TtsIdentity;
  synthesize(text: string, signal: AbortSignal): Promise<TtsAudio>;
}

export type TtsErrorCode =
  | "invalid_configuration"
  | "invalid_text"
  | "cancelled"
  | "timeout"
  | "provider_rejected"
  | "provider_unavailable"
  | "invalid_response"
  | "download_failed"
  | "audio_too_large"
  | "invalid_audio";

export class TtsError extends Error {
  constructor(readonly code: TtsErrorCode) {
    super(`TTS ${code}`);
    this.name = "TtsError";
  }
}

/** 稳定键只用于本地复用；不能消除远端成功、本地未登记时的重复计费窗口。 */
export function ttsTaskKey(
  sourceInformationId: string,
  text: string,
  identity: TtsIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "kaguya.tts.v1",
        sourceInformationId,
        text,
        identity.provider,
        identity.accountScope,
        identity.region,
        identity.model,
        identity.voice,
        identity.language,
      ]),
    )
    .digest("hex");
}
