/**
 * 功能概述：声明独立 Memory 底座的稳定领域契约与无语言绑定的稀疏归一规则。
 * 同时导出独立 embedding/vector capability 与 HybridMemoryRecall；向量只作为派生索引。
 * 主要职责：定义消息文档、平台原生检索 key、写入/召回端口、模块 capability，
 * 并提供 NFKC Unicode 2-gram 生成与严格输入校验。
 * 代码库关系：database 实现这些端口，Runtime 将 recall 暴露为命名检索策略，
 * modules 只通过 capability 写入；本包不依赖 Information Ledger 或具体数据库。
 * 输入输出与副作用：校验与 gram 生成是纯函数；接口本身不执行 I/O。
 */
import {
  informationIdSchema,
  platformDestinationSchema,
  type PlatformDestination,
  z,
} from "@kaguya/schema";
import { defineModuleCapability } from "@kaguya/sdk";

export const MEMORY_MAX_CONTENT_CODE_POINTS = 16_384;
export const MEMORY_MAX_QUERY_CODE_POINTS = 512;
export const MEMORY_MAX_FILTER_KEYS = 100;
export const MEMORY_RETRIEVAL_STRATEGY_ID = "kaguya.memory.sparse";

const nonBlankString = z.string().trim().min(1);
const boundedCodePoints = (maximum: number, label: string) =>
  z.string().refine((value) => Array.from(value).length <= maximum, {
    message: `${label} exceeds ${maximum} Unicode code points`,
  });

export const memoryNamespaceKeySchema = z
  .object({ platform: nonBlankString, adapterId: nonBlankString })
  .strict();
export type MemoryNamespaceKey = Readonly<
  z.infer<typeof memoryNamespaceKeySchema>
>;

export const memoryAccountKeySchema = memoryNamespaceKeySchema
  .extend({ accountId: nonBlankString })
  .strict();
export type MemoryAccountKey = Readonly<z.infer<typeof memoryAccountKeySchema>>;

export const memoryScopeKeySchema = memoryNamespaceKeySchema
  .extend({ destination: platformDestinationSchema })
  .strict();
export type MemoryScopeKey = Readonly<z.infer<typeof memoryScopeKeySchema>>;

export const memoryAddressSchema = memoryAccountKeySchema
  .extend({
    platformMessageId: nonBlankString,
    destination: platformDestinationSchema,
  })
  .strict();
export type MemoryAddress = Readonly<z.infer<typeof memoryAddressSchema>>;

export const memoryDocumentInputSchema = z
  .object({
    sourceInformationId: informationIdSchema,
    sourceKind: nonBlankString,
    content: boundedCodePoints(
      MEMORY_MAX_CONTENT_CODE_POINTS,
      "memory content",
    ).refine((value) => value.trim().length > 0, {
      message: "memory content must not be blank",
    }),
    occurredAt: z.iso.datetime({ offset: true }),
    address: memoryAddressSchema,
  })
  .strict();
export type MemoryDocumentInput = Readonly<
  z.infer<typeof memoryDocumentInputSchema>
>;

export interface MemoryDocument extends MemoryDocumentInput {
  readonly memoryId: string;
  readonly createdAt: string;
}

export interface MemoryPutResult {
  readonly document: MemoryDocument;
  readonly created: boolean;
}

export const memoryRecallQuerySchema = z
  .object({
    query: boundedCodePoints(
      MEMORY_MAX_QUERY_CODE_POINTS,
      "memory query",
    ).refine((value) => value.trim().length > 0, {
      message: "memory query must not be blank",
    }),
    namespaces: z
      .array(memoryNamespaceKeySchema)
      .max(MEMORY_MAX_FILTER_KEYS)
      .optional(),
    accounts: z
      .array(memoryAccountKeySchema)
      .max(MEMORY_MAX_FILTER_KEYS)
      .optional(),
    scopes: z
      .array(memoryScopeKeySchema)
      .max(MEMORY_MAX_FILTER_KEYS)
      .optional(),
    occurredBefore: z.iso.datetime({ offset: true }).optional(),
    excludeSourceInformationIds: z
      .array(informationIdSchema)
      .max(MEMORY_MAX_FILTER_KEYS)
      .optional(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export interface MemoryRecallQuery {
  readonly query: string;
  readonly namespaces?: readonly MemoryNamespaceKey[];
  readonly accounts?: readonly MemoryAccountKey[];
  readonly scopes?: readonly MemoryScopeKey[];
  readonly occurredBefore?: string;
  readonly excludeSourceInformationIds?: readonly string[];
  readonly limit: number;
}

export interface MemoryRecallHit {
  readonly document: MemoryDocument;
  /** 排序相关度只承诺越大越相关；调用方不得依赖具体算法或量纲。 */
  readonly score: number;
}

export interface MemoryStore {
  put(input: MemoryDocumentInput): Promise<MemoryPutResult>;
}

export interface MemoryRecall {
  recall(query: MemoryRecallQuery): Promise<readonly MemoryRecallHit[]>;
}

export type MemoryAccess = MemoryStore & MemoryRecall;

export const memoryCapability = defineModuleCapability<MemoryAccess>(
  "kaguya:memory",
  1,
);

export class InvalidMemoryInputError extends Error {
  constructor(
    readonly inputType: "document" | "query",
    options?: ErrorOptions,
  ) {
    super(`Invalid memory ${inputType} input`, options);
    this.name = "InvalidMemoryInputError";
  }
}

export class MemorySourceConflictError extends Error {
  constructor(readonly sourceInformationId: string) {
    super(`Memory source conflict: ${sourceInformationId}`);
    this.name = "MemorySourceConflictError";
  }
}

export function parseMemoryDocumentInput(input: unknown): MemoryDocumentInput {
  const parsed = memoryDocumentInputSchema.safeParse(input);
  if (!parsed.success)
    throw new InvalidMemoryInputError("document", { cause: parsed.error });
  return freezeDocumentInput(parsed.data);
}

export function parseMemoryRecallQuery(input: unknown): MemoryRecallQuery {
  const parsed = memoryRecallQuerySchema.safeParse(input);
  if (!parsed.success)
    throw new InvalidMemoryInputError("query", { cause: parsed.error });
  return Object.freeze({
    query: parsed.data.query,
    limit: parsed.data.limit,
    ...(parsed.data.occurredBefore === undefined
      ? {}
      : { occurredBefore: parsed.data.occurredBefore }),
    ...(parsed.data.namespaces === undefined
      ? {}
      : { namespaces: freezeObjects(parsed.data.namespaces) }),
    ...(parsed.data.accounts === undefined
      ? {}
      : { accounts: freezeObjects(parsed.data.accounts) }),
    ...(parsed.data.scopes === undefined
      ? {}
      : {
          scopes: Object.freeze(
            parsed.data.scopes.map((scope) =>
              Object.freeze({
                ...scope,
                destination: Object.freeze({ ...scope.destination }),
              }),
            ),
          ),
        }),
    ...(parsed.data.excludeSourceInformationIds === undefined
      ? {}
      : {
          excludeSourceInformationIds: Object.freeze([
            ...parsed.data.excludeSourceInformationIds,
          ]),
        }),
  });
}

/** 最小字符倒排路径：去重后的 Unicode code-point bigram。 */
export function memorySparseGrams(value: string): readonly string[] {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
  const codePoints = Array.from(normalized);
  if (codePoints.length === 0) return Object.freeze([]);
  if (codePoints.length === 1) return Object.freeze([codePoints[0]!]);
  const grams = new Set<string>();
  for (let index = 0; index < codePoints.length - 1; index += 1) {
    grams.add(codePoints[index]! + codePoints[index + 1]!);
  }
  return Object.freeze([...grams]);
}

/** 文档额外索引唯一单字符，使单字符 query 不需要退化为全表 LIKE。 */
export function memorySparseDocumentGrams(value: string): readonly string[] {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
  const codePoints = Array.from(normalized);
  return Object.freeze([
    ...new Set([...memorySparseGrams(value), ...codePoints]),
  ]);
}

export function memoryDestinationIdentity(destination: PlatformDestination): {
  readonly kind: PlatformDestination["kind"];
  readonly id?: string;
} {
  if (destination.kind === "private")
    return Object.freeze({ kind: destination.kind, id: destination.userId });
  if (destination.kind === "group")
    return Object.freeze({ kind: destination.kind, id: destination.groupId });
  return Object.freeze({ kind: destination.kind });
}

function freezeDocumentInput(input: z.infer<typeof memoryDocumentInputSchema>) {
  return Object.freeze({
    ...input,
    address: Object.freeze({
      ...input.address,
      destination: Object.freeze({ ...input.address.destination }),
    }),
  });
}

function freezeObjects<T extends Record<string, unknown>>(
  values: readonly T[],
) {
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}
