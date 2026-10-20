/**
 * 功能概述：定义宿主提供的 TTS 配置、合成和存储端口。
 * 主要职责：按当前会话显式启用，持久化产物与复核有效期；模块不接触凭据。
 * 代码库关系：Heavy 和 TTS 模块共用此能力；宿主负责配置、授权与真实 transport 能力。
 * 输入输出与副作用：接口声明本身无副作用。
 */
import type { TtsAudio, TtsIdentity } from "@kaguya/llm";
import type {
  AudioResource,
  DeepReadonly,
  InformationAtom,
} from "@kaguya/schema";
import { defineModuleCapability } from "@kaguya/sdk";
import type { TtsRequest } from "./facts.js";

export interface TtsHost {
  /** 仅当前会话显式配置且适配器确实支持音频才返回计划；跨会话必须返回 undefined。 */
  plan(assistant: DeepReadonly<InformationAtom>): Promise<
    | {
        identity: TtsIdentity;
        expiresAt: string;
        maxCharacters: number;
      }
    | undefined
  >;
  /** 复核目标授权、回合和取消状态；不得仅凭持久化请求自行授权。 */
  isCurrent(request: TtsRequest): Promise<boolean>;
  synthesize(request: TtsRequest, signal: AbortSignal): Promise<TtsAudio>;
  find(taskKey: string): Promise<AudioResource | undefined>;
  save(taskKey: string, audio: TtsAudio): Promise<AudioResource>;
  exists(audio: AudioResource): Promise<boolean>;
}
export const ttsCapability = defineModuleCapability<TtsHost>("kaguya:tts", 1);
