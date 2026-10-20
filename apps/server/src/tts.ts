/**
 * 功能概述：从选中 Profile 的 provider settings.tts 装配可选语音宿主。
 * 主要职责：复用现有秘密字段；显式会话范围、账本终态校验、持久化音频。
 * 代码库关系：Server 将能力交给 Composition，并把同一存储的读取器交给 NapCat。
 * 输入输出与副作用：关闭时无磁盘或网络操作；合成只使用当前 Profile 凭据。
 */
import { join } from "node:path";
import type { UserConfigProfile } from "@kaguya/config";
import { createQwenTtsProvider, ttsTaskKey } from "@kaguya/llm";
import {
  assistantTextInformationKind,
  type TtsHost,
  type TtsRequest,
} from "@kaguya/modules";
import {
  GatewayAllowlist,
  TtsAudioStore,
  type RuntimeCapabilityContext,
} from "@kaguya/runtime";
import { z, type AudioResource } from "@kaguya/schema";
import { defineInformationSelector } from "@kaguya/sdk";
import type { NapCatConfig } from "./config.js";

export const serverTtsSettingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  region: z.enum(["beijing", "singapore"]),
  accountScope: z.string().trim().min(1),
  model: z.string().trim().min(1),
  voice: z.string().trim().min(1),
  language: z.string().default("Chinese"),
  audioHosts: z.array(z.string()).min(1),
  conversations: z
    .array(z.string().regex(/^qq:(group|private):[0-9]+$/u))
    .default([]),
  maxCharacters: z.int().min(1).max(600).default(300),
  timeoutMs: z.int().min(1000).max(120000).default(30000),
  requestTtlMs: z.int().min(1000).max(300000).default(120000),
});
const terminal = defineInformationSelector({
  selectorId: "server.tts.turn-terminal",
  async select({ sourceAtom, ledger }) {
    return (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 64,
      })
    )
      .filter((a) =>
        [
          "completed",
          "failed",
          "silent",
          "waiting",
          "superseded",
          "interrupted",
        ].some((suffix) => a.kind === `agent.router.turn.${suffix}`),
      )
      .map((a) => a.informationId);
  },
});

function enabledProviders(profile: UserConfigProfile) {
  return profile.ai.providers.filter((p) => {
    const value = p.settings.tts;
    return (
      p.enabled &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.enabled === true
    );
  });
}
export function hasEnabledTts(profile: UserConfigProfile): boolean {
  return enabledProviders(profile).length > 0;
}
export function createServerTts(
  profile: UserConfigProfile,
  root: string,
  napcat: NapCatConfig,
) {
  const configured = enabledProviders(profile);
  if (!configured.length) return undefined;
  if (configured.length !== 1)
    throw new Error("Only one TTS provider may be enabled");
  const provider = configured[0]!;
  const settings = serverTtsSettingsSchema.parse(provider.settings.tts);
  const synth = createQwenTtsProvider({
    identity: {
      provider: "qwen",
      accountScope: settings.accountScope,
      region: settings.region,
      model: settings.model,
      voice: settings.voice,
      language: settings.language,
    },
    apiKey: provider.apiKey ?? "",
    audioHosts: settings.audioHosts,
    timeoutMs: settings.timeoutMs,
  });
  const allow = new GatewayAllowlist(settings.conversations);
  const outbound = new GatewayAllowlist(
    profile.runtime?.outboundAllowlist ?? [],
  );
  let storage: Promise<TtsAudioStore> | undefined;
  const store = () => (storage ??= TtsAudioStore.open(join(root, "tts-audio")));
  const allowed = (target: TtsRequest["target"]) =>
    napcat.enabled &&
    !napcat.configurationError &&
    target.adapterId === napcat.adapterId &&
    target.platform === "qq" &&
    allow.allowsDestination(target.platform, target.destination) &&
    outbound.allowsDestination(target.platform, target.destination);
  return {
    resolveAudio: async (resource: AudioResource) =>
      (await store()).bytes(resource),
    host: ({ core, now }: RuntimeCapabilityContext): TtsHost => {
      const isCurrent = async (request: TtsRequest) => {
        if (
          !allowed(request.target) ||
          Date.parse(request.expiresAt) <= now().getTime() ||
          ttsTaskKey(
            request.assistantInformationId,
            request.text,
            synth.identity,
          ) !== request.taskKey
        )
          return false;
        const atom = await core.get(request.assistantInformationId);
        if (!atom || atom.kind !== assistantTextInformationKind.kind)
          return false;
        const parsed = assistantTextInformationKind.payloadSchema.safeParse(
          atom.payload,
        );
        if (
          !parsed.success ||
          parsed.data.text !== request.text ||
          JSON.stringify(parsed.data.source) !==
            JSON.stringify(request.target) ||
          JSON.stringify(parsed.data.turn) !== JSON.stringify(request.turn)
        )
          return false;
        if (request.turn) {
          if (
            !(await core.get(request.turn.candidateInformationId)) ||
            (await core.select(terminal, request.turn.candidateInformationId))
              .length
          )
            return false;
        }
        return true;
      };
      return {
        async plan(assistant) {
          const parsed = assistantTextInformationKind.payloadSchema.safeParse(
            assistant.payload,
          );
          if (
            assistant.kind !== assistantTextInformationKind.kind ||
            !parsed.success ||
            !allowed(parsed.data.source)
          )
            return undefined;
          try {
            await (await store()).prune();
          } catch {
            return undefined;
          }
          return {
            identity: synth.identity,
            expiresAt: new Date(
              now().getTime() + settings.requestTtlMs,
            ).toISOString(),
            maxCharacters: settings.maxCharacters,
          };
        },
        isCurrent,
        async synthesize(request, signal) {
          if (!(await isCurrent(request)))
            throw new Error("TTS request no longer current");
          return synth.synthesize(request.text, signal);
        },
        find: async (key) => (await store()).find(key),
        save: async (key, audio) => (await store()).save(key, audio),
        exists: async (audio) => (await store()).exists(audio),
      };
    },
  };
}
