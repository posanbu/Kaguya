/**
 * 功能概述：定义外部认知 provider 的严格文档输入、来源输出与受控 Mem0 REST 适配器。
 * MemoryCognitionProvider 仅接收已持久化文档快照；validateCognitionResult 拒绝缺失、乱序或越权来源。
 * Mem0CognitionProvider 将每个 operation 映射为独立命名空间，委托外部服务提取/消解冲突，
 * 再把最终可见事实与完整输入证据关联；本包不实现事实提取、合并或演化启发式。
 * 所有 HTTP 受 abort、超时与响应大小限制，错误只返回固定分类；API key 为私有字段，不提供给模块。
 */
import { defineModuleCapability } from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import { memoryDocumentInputSchema, type MemoryDocument } from "./contracts.js";
export const cognitionIdentitySchema = z
  .object({ providerId: z.string().min(1), revision: z.string().min(1) })
  .strict();
export type CognitionIdentity = Readonly<
  z.infer<typeof cognitionIdentitySchema>
>;
export const cognitionDocumentSchema = memoryDocumentInputSchema
  .extend({
    memoryId: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const cognitionInputSchema = z
  .object({
    operationKey: z.string().min(1),
    documents: z.array(cognitionDocumentSchema).min(1).max(32),
    sourceInformationIds: z.array(z.string().min(1)).min(1).max(32),
  })
  .strict();
export interface MemoryCognitionInput {
  readonly operationKey: string;
  readonly documents: readonly MemoryDocument[];
  readonly sourceInformationIds: readonly string[];
}
export const cognitionResultSchema = z
  .object({
    facts: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(4000),
            sourceInformationIds: z.array(z.string().min(1)).min(1).max(32),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type MemoryCognitionResult = z.infer<typeof cognitionResultSchema>;
export interface MemoryCognitionProvider {
  readonly identity: CognitionIdentity;
  evolve(
    input: MemoryCognitionInput,
    signal: AbortSignal,
  ): Promise<MemoryCognitionResult>;
}
export const memoryCognitionCapability =
  defineModuleCapability<MemoryCognitionProvider>("kaguya:memory.cognition", 1);
export function validateCognitionInput(input: MemoryCognitionInput): void {
  cognitionInputSchema.parse(input);
  if (
    new Set(input.sourceInformationIds).size !== input.documents.length ||
    input.documents.some(
      (doc, index) =>
        doc.sourceInformationId !== input.sourceInformationIds[index] ||
        doc.sourceKind !== "core.message.inbound.text",
    )
  )
    throw new Error("Invalid cognition source order");
  const first = input.documents[0]!.address;
  for (const doc of input.documents)
    if (
      doc.address.platform !== first.platform ||
      doc.address.adapterId !== first.adapterId ||
      doc.address.accountId !== first.accountId ||
      JSON.stringify(doc.address.destination) !==
        JSON.stringify(first.destination)
    )
      throw new Error("Mixed cognition scope");
}
/** 冻结传给可替换 provider 的副本，避免它通过修改数组改变之后的来源校验边界。 */
export function freezeCognitionInput(
  input: MemoryCognitionInput,
): MemoryCognitionInput {
  const parsed = cognitionInputSchema.parse(input);
  validateCognitionInput(parsed);
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(parsed);
  return parsed;
}
export function validateCognitionResult(
  result: unknown,
  input: MemoryCognitionInput,
): MemoryCognitionResult {
  validateCognitionInput(input);
  const parsed = cognitionResultSchema.parse(result);
  for (const fact of parsed.facts) {
    const selected = new Set(fact.sourceInformationIds);
    if (
      selected.size !== fact.sourceInformationIds.length ||
      JSON.stringify(
        input.sourceInformationIds.filter((id) => selected.has(id)),
      ) !== JSON.stringify(fact.sourceInformationIds)
    )
      throw new Error("Invalid cognition evidence");
  }
  return parsed;
}
export function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new Error("Memory operation aborted"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Memory operation aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("Memory provider unavailable"));
      },
    );
  });
}
export class Mem0CognitionProvider implements MemoryCognitionProvider {
  readonly identity: CognitionIdentity;
  readonly #url: URL;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  constructor(options: {
    baseUrl: string;
    apiKey: string;
    revision: string;
    fetch?: typeof fetch;
  }) {
    this.identity = Object.freeze({
      providerId: "mem0-rest",
      revision: options.revision,
    });
    cognitionIdentitySchema.parse(this.identity);
    this.#url = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    if (
      !["https:", "http:"].includes(this.#url.protocol) ||
      this.#url.username ||
      this.#url.password ||
      this.#url.search ||
      this.#url.hash
    )
      throw new Error("Invalid cognition endpoint");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }
  async evolve(
    input: MemoryCognitionInput,
    signal: AbortSignal,
  ): Promise<MemoryCognitionResult> {
    validateCognitionInput(input);
    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([this.identity, input.operationKey]),
        ),
      );
      const namespace = `kaguya-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      await this.request("memories", signal, {
        method: "POST",
        body: JSON.stringify({
          user_id: namespace,
          run_id: namespace,
          infer: true,
          messages: input.documents.map((doc) => ({
            role: "user",
            content: doc.content,
          })),
          metadata: { sourceInformationIds: input.sourceInformationIds },
        }),
      });
      const result = await this.request(
        `memories?user_id=${namespace}&run_id=${namespace}&top_k=33`,
        signal,
      );
      const parsed = z
        .object({
          results: z
            .array(
              z
                .object({
                  memory: z.string().trim().min(1).max(4000),
                  user_id: z.string(),
                  metadata: z
                    .object({
                      sourceInformationIds: z.array(z.string()).min(1).max(32),
                    })
                    .passthrough(),
                })
                .passthrough(),
            )
            .max(32),
        })
        .passthrough()
        .parse(result);
      if (
        parsed.results.some(
          (item) =>
            item.user_id !== namespace ||
            JSON.stringify(item.metadata.sourceInformationIds) !==
              JSON.stringify(input.sourceInformationIds),
        )
      )
        throw new Error("Invalid provider provenance");
      return validateCognitionResult(
        {
          facts: parsed.results.map((item) => ({
            text: item.memory,
            sourceInformationIds: [...input.sourceInformationIds],
          })),
        },
        input,
      );
    } catch {
      throw new Error("Memory cognition provider unavailable");
    }
  }
  private async request(
    path: string,
    signal: AbortSignal,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this.#fetch(new URL(path, this.#url), {
      ...init,
      signal,
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.#apiKey,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Memory cognition request failed");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing cognition response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256_000) throw new Error("Oversized cognition response");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
}
