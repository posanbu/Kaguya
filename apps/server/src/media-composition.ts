/**
 * 功能概述：按已应用 Profile 装配 Runtime 三档媒体能力；初始化与配置热应用共用同一入口。
 * createServerMediaComposition 给入站配置受控下载，native 只批准 Heavy 模型，external 使用
 * 原有 ModelTaskClient 所需的单模型 LLM 端口和统一结构化提示渲染器；本函数不发请求。
 * visual 模型由 Server 既有 provider resolver 解析，凭据不写入配置身份、素材记录或观察内容。
 */
import { createHash } from "node:crypto";
import type { UserConfigProfile } from "@kaguya/config";
import type { RuntimeModelSelectionResolver } from "@kaguya/composition";
import { KaguyaLlmClient } from "@kaguya/llm/client";
import { loadStructuredOutputPromptRenderer } from "@kaguya/llm/prompt-templates/node";
import type { KaguyaRuntimeOptions } from "@kaguya/runtime";
import { createMediaDownloader } from "./media-download.js";
export function createServerMediaComposition(
  profile: UserConfigProfile,
  resolveVision?: () => ReturnType<RuntimeModelSelectionResolver>,
): Pick<KaguyaRuntimeOptions, "mediaInput" | "mediaVisionTask"> {
  const mode = profile.ai.vision?.mode ?? "off";
  const heavy = profile.ai.modelTiers?.heavy;
  const mediaInput = {
    mode,
    acquire: createMediaDownloader(profile.ai.vision?.allowedHosts ?? []),
    ...(mode === "native" && heavy
      ? {
          nativeModel: { providerId: heavy.providerId, modelId: heavy.modelId },
        }
      : {}),
  };
  if (mode !== "external") return { mediaInput };
  if (!resolveVision) throw new Error("Vision model resolver missing");
  const selected = resolveVision();
  const identity = {
    providerId: selected.providerId,
    modelId: selected.modelId,
    configurationDigest: createHash("sha256")
      .update(
        JSON.stringify({
          configuration: selected.configuration ?? null,
          generationOptions: selected.generationOptions ?? {},
        }),
      )
      .digest("hex"),
  };
  return {
    mediaInput,
    mediaVisionTask: {
      client: new KaguyaLlmClient({
        resolveModel: ({ modelId }) => {
          if (modelId !== selected.modelId)
            throw new Error("Unapproved vision model");
          return selected.model;
        },
        resolveGenerationOptions: () => selected.generationOptions ?? {},
      }),
      resolveModel: () => identity,
      renderStructuredOutputPrompt: loadStructuredOutputPromptRenderer(),
    },
  };
}
