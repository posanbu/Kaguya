/**
 * 功能概述：通过既有 AI SDK 的 OpenAI-compatible embedding model 构造窄文本向量客户端。
 * createCompatibleEmbeddingProvider 冻结模型/revision/维度身份，embed 传播 abort 并关闭 SDK 自动重试，
 * 将重试统一交给 Memory 的 Reliable Runner；返回值不含密钥、HTTP 元数据或 provider 原始错误。
 * composition 从 selected Profile 创建本客户端，Memory 只依赖其结构端口，不依赖具体 SDK。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed } from "ai";
export function createCompatibleEmbeddingProvider(options: {
  providerId: string;
  modelId: string;
  revision: string;
  dimensions: number;
  baseUrl: string;
  apiKey: string;
}) {
  const provider = createOpenAICompatible({
    name: options.providerId,
    baseURL: options.baseUrl,
    apiKey: options.apiKey,
  });
  return Object.freeze({
    identity: Object.freeze({
      modelId: JSON.stringify([options.providerId, options.modelId]),
      revision: options.revision,
      dimensions: options.dimensions,
    }),
    embed: async (
      text: string,
      signal: AbortSignal,
    ): Promise<readonly number[]> => {
      try {
        return (
          await embed({
            model: provider.embeddingModel(options.modelId),
            value: text,
            abortSignal: signal,
            maxRetries: 0,
          })
        ).embedding;
      } catch {
        throw new Error("Memory embedding provider unavailable");
      }
    },
  });
}
