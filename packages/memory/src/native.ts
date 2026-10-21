/** Unified memory ports and deterministic retrieval policy. No database or model SDK dependencies. */
/** Unified memory ports and deterministic retrieval policy. No database or model SDK dependencies. */
import {
  nativeMemorySnapshotSchema,
  type NativeMemoryNode,
  type NativeMemorySnapshot,
  type MemoryPublication,
} from "@kaguya/schema";
import { defineModuleCapability } from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import type { EmbeddingProvider } from "./vector.js";
export const nativeEmbeddingSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    providerId: z.string().default(""),
    modelId: z.string().default(""),
    revision: z.string().default("1"),
    dimensions: z.number().int().min(1).max(16000).default(1536),
    timeoutMs: z.number().int().min(100).max(2000).default(2000),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.enabled)
      for (const key of ["providerId", "modelId", "revision"] as const)
        if (!config[key].trim())
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "Enabled embedding requires a non-empty value",
          });
  });
export const nativeMemorySettingsSchema = z
  .object({
    semanticEmbedding: nativeEmbeddingSettingsSchema
      .default({
        enabled: false,
        providerId: "",
        modelId: "",
        revision: "1",
        dimensions: 1536,
        timeoutMs: 2000,
      })
      .meta({
        title: "语义辅助检索",
        description:
          "独立设置 enabled、providerId、modelId、revision、dimensions 和 timeoutMs。提供方来自已配置的 AI 服务。",
        public: true,
      }),
    languageEmbedding: nativeEmbeddingSettingsSchema
      .default({
        enabled: false,
        providerId: "",
        modelId: "",
        revision: "1",
        dimensions: 1536,
        timeoutMs: 2000,
      })
      .meta({
        title: "语言与字面相似检索",
        description: "独立设置文字相似模型。未配置时关闭，不影响图和文本检索。",
        public: true,
      }),
  })
  .strict();
export interface NativeEmbeddingSource {
  role: "semantic" | "language";
  provider: EmbeddingProvider;
  timeoutMs: number;
}
export {
  nativeMemoryMetadataSchema,
  nativeMemoryNodeSchema,
  memoryPublicationSchema,
  nativeMemorySnapshotSchema,
  type NativeMemoryNode,
  type NativeMemorySnapshot,
  type MemoryPublication,
} from "@kaguya/schema";

export const NATIVE_MEMORY_REVISION_KIND = "memory.native.revision.v1";
export const MEMORY_ANALYZER_VERSION = "nfkc-cjk2-v1";
export interface MemoryReadContext {
  scope: string;
  owners: readonly string[];
  asOf: string;
  query: string;
  explicitIds?: readonly string[];
  people?: readonly MemoryPersonBinding[];
  participants?: NativeMemorySnapshot["participants"];
}
export interface MemoryCandidate {
  node: NativeMemoryNode;
  channel: string;
  indexVersion?: string;
  rank: number;
  path?: string[];
}
export interface NativeMemoryStore {
  withReadSnapshot?<T>(
    run: (store: NativeMemoryStore) => Promise<T>,
  ): Promise<T>;
  publish(input: MemoryPublication): Promise<readonly NativeMemoryNode[]>;
  readFixed(input: MemoryReadContext): Promise<readonly NativeMemoryNode[]>;
  candidates(input: MemoryReadContext): Promise<readonly MemoryCandidate[]>;
  expand(
    input: MemoryReadContext,
    ids: readonly string[],
  ): Promise<readonly MemoryCandidate[]>;
  current(
    input: MemoryReadContext,
    ids: readonly string[],
  ): Promise<readonly NativeMemoryNode[]>;
  forFormation(input: MemoryReadContext): Promise<readonly NativeMemoryNode[]>;
  history(id: string): Promise<readonly unknown[]>;
  published(
    operationId: string,
  ): Promise<readonly NativeMemoryNode[] | undefined>;
  people?(input: MemoryPeopleInput): Promise<MemoryPersonBinding[]>;
}
export interface MemoryPersonBinding {
  accountId: string;
  ownerId: string;
}
export interface MemoryPeopleInput {
  platform: string;
  adapterId: string;
  accountIds: readonly string[];
}
export interface MemoryAuxiliaryRetriever {
  /** Equal identities vote only once, even if configured for both roles. */
  identity: string;
  role: "semantic" | "language";
  search(
    input: MemoryReadContext,
    signal: AbortSignal,
  ): Promise<readonly NativeMemoryNode[]>;
  index?(signal?: AbortSignal): Promise<void>;
}
export interface NativeMemoryAccess {
  readonly enabled: boolean;
  publish(input: MemoryPublication): Promise<readonly NativeMemoryNode[]>;
  freeze(input: MemoryReadContext): Promise<NativeMemorySnapshot>;
  prepare(input: MemoryReadContext): Promise<NativeMemorySnapshot>;
  index(signal?: AbortSignal): Promise<void>;
  people(input: MemoryPeopleInput): Promise<MemoryPersonBinding[]>;
  published(
    operationId: string,
  ): Promise<readonly NativeMemoryNode[] | undefined>;
}
export const nativeMemoryCapability =
  defineModuleCapability<NativeMemoryAccess>("memory:native", 1);
export const memorySourcePersonSchema = z
  .object({
    accountId: z.string(),
    ownerId: z.string().nullable(),
    role: z.enum(["speaker", "mentioned", "replied-to", "recipient"]),
    nickname: z.string().nullable(),
    card: z.string().nullable(),
  })
  .strict();
export const memorySourceSchema = z
  .object({
    id: z.string(),
    scope: z.string(),
    ownerId: z.string(),
    text: z.string(),
    occurredAt: z.string(),
    collectedAt: z.string(),
    sourceType: z.enum(["inbound", "delivered"]),
    participants: z.array(memorySourcePersonSchema),
    replyTo: z
      .object({
        platformMessageId: z.string(),
        senderId: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type MemorySource = z.infer<typeof memorySourceSchema>;
export interface MemoryBatch {
  id: string;
  scope: string;
  sources: MemorySource[];
}
export interface MemoryFormationAccess {
  ingest(source: MemorySource): Promise<boolean>;
  claim(
    scope: string,
    force: boolean,
    asOf?: string,
  ): Promise<MemoryBatch | undefined>;
  finish(
    id: string,
    status: "completed" | "rejected" | "failed",
  ): Promise<void>;
}
export const memoryFormationCapability =
  defineModuleCapability<MemoryFormationAccess>("memory:formation", 1);
export function memoryScope(source: {
  platform: string;
  adapterId: string;
  destination: {
    kind: string;
    userId?: string;
    groupId?: string;
    conversationId?: string;
  };
}): string {
  const d = source.destination;
  return JSON.stringify([
    source.platform,
    source.adapterId,
    d.kind,
    d.userId ?? d.groupId ?? d.conversationId ?? null,
  ]);
}
export function memoryTerms(text: string): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("und");
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((word) => {
        const chars = Array.from(word);
        if (!/\p{Script=Han}/u.test(word)) return [word];
        return chars.length === 1
          ? chars
          : chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
      }),
    ),
  ].slice(0, 512);
}
export function memoryFuzzyTerms(text: string): string[] {
  const words =
    text
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((word) => {
        const chars = Array.from(word),
          size = /\p{Script=Han}/u.test(word) ? 2 : 3;
        return [
          ...chars.filter((c) => /\p{Script=Han}/u.test(c)),
          ...chars
            .slice(0, Math.max(1, chars.length - size + 1))
            .map((_, i) => chars.slice(i, i + size).join("")),
        ];
      }),
    ),
  ].slice(0, 2048);
}
/** Bounded edit distance; long inputs never cause an unbounded fuzzy expansion. */
export function memoryEditDistance(
  left: string,
  right: string,
  limit = 2,
): number {
  const a = Array.from(left).slice(0, 64),
    b = Array.from(right).slice(0, 64);
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(
          next[j]! + 1,
          previous[j + 1]! + 1,
          previous[j]! + (a[i] === b[j] ? 0 : 1),
        ),
      );
    if (Math.min(...next) > limit) return limit + 1;
    previous = next;
  }
  return previous[b.length]!;
}
export function fuseMemoryCandidates(
  candidates: readonly MemoryCandidate[],
): MemoryCandidate[][] {
  const groups = new Map<string, Map<string, MemoryCandidate>>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.node.id) ?? new Map();
    const previous = group.get(candidate.channel);
    if (!previous || previous.rank > candidate.rank)
      group.set(candidate.channel, candidate);
    groups.set(candidate.node.id, group);
  }
  const score = (items: MemoryCandidate[]) =>
    items.reduce((sum, c) => sum + 1 / (60 + c.rank), 0);
  return [...groups.values()]
    .map((g) => [...g.values()])
    .sort(
      (a, b) =>
        Number(b.some((c) => c.channel === "explicit")) -
          Number(a.some((c) => c.channel === "explicit")) ||
        score(b) - score(a) ||
        a[0]!.node.id.localeCompare(b[0]!.node.id),
    );
}
async function collectAuxiliary(
  options: {
    retrievers?: readonly MemoryAuxiliaryRetriever[];
    auxiliaryTimeoutMs?: number;
  },
  input: MemoryReadContext,
) {
  const candidates: MemoryCandidate[] = [];
  const degraded: string[] = [];
  const unique = new Map(
    (options.retrievers ?? []).map((r) => [r.identity, r]),
  );
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, options.auxiliaryTimeoutMs ?? 2000);
  });
  try {
    await Promise.all(
      [...unique.values()].map(async (retriever) => {
        try {
          const nodes = await Promise.race([
            retriever.search(input, controller.signal),
            deadline,
          ]);
          nodes.slice(0, 50).forEach((node, index) =>
            candidates.push({
              node,
              indexVersion: retriever.identity,
              channel: retriever.role,
              rank: index + 1,
            }),
          );
        } catch {
          degraded.push(retriever.role);
        }
      }),
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { candidates, degraded };
}
export function createNativeMemoryAccess(
  options: {
    enabled: boolean;
    store: NativeMemoryStore;
    retrievers?: readonly MemoryAuxiliaryRetriever[];
    auxiliaryTimeoutMs?: number;
  },
  inSnapshot = false,
  auxiliaryResult?: { candidates: MemoryCandidate[]; degraded: string[] },
): NativeMemoryAccess {
  return {
    enabled: options.enabled,
    async prepare(input) {
      if (!options.enabled) throw new Error("MEMORY_DISABLED");
      const nodes = await options.store.forFormation(input);
      return {
        version: 1,
        status: "enabled",
        frozenAt: input.asOf,
        scope: input.scope,
        owners: [...input.owners],
        people: [...(input.people ?? [])],
        participants: structuredClone(input.participants ?? []),
        fixed: nodes.filter((n) => n.metadata.level === 0),
        recalled: nodes
          .filter((n) => n.metadata.level !== 0)
          .map((node) => ({ node, traces: [], truncated: false })),
        degraded: [],
        budget: { dynamicCharacters: 0, omittedNodeIds: [] },
      };
    },
    published: (id) => options.store.published(id),
    async people(input) {
      return options.enabled
        ? ((await options.store.people?.(input)) ?? [])
        : [];
    },
    async index(signal) {
      if (!options.enabled) return;
      await Promise.allSettled(
        (options.retrievers ?? []).map((r) => r.index?.(signal)),
      );
    },
    publish: (input) => {
      if (!options.enabled) throw new Error("MEMORY_DISABLED");
      return options.store.publish(input);
    },
    async freeze(input) {
      if (options.enabled && !inSnapshot && options.store.withReadSnapshot) {
        // Do not hold a database snapshot while waiting for remote models or another pool connection.
        const auxiliary = await collectAuxiliary(options, input);
        return options.store.withReadSnapshot((store) =>
          createNativeMemoryAccess(
            { ...options, store },
            true,
            auxiliary,
          ).freeze(input),
        );
      }
      const empty = {
        version: 1 as const,
        status: "disabled" as const,
        frozenAt: input.asOf,
        scope: input.scope,
        owners: [...input.owners],
        people: [...(input.people ?? [])],
        participants: structuredClone(input.participants ?? []),
        fixed: [],
        recalled: [],
        degraded: [],
        budget: { dynamicCharacters: 0, omittedNodeIds: [] },
      };
      if (!options.enabled) return empty;
      // Fixed reads are mandatory and intentionally outside all retrieval quotas.
      const fixed = await options.store.readFixed(input);
      const candidates = [...(await options.store.candidates(input))];
      const auxiliary =
        auxiliaryResult ?? (await collectAuxiliary(options, input));
      candidates.push(...auxiliary.candidates);
      const degraded = auxiliary.degraded;
      const versions = new Map(
        (
          await options.store.current(
            input,
            candidates.map((c) => c.node.id),
          )
        ).map((n) => [n.id, n.metadata.revision]),
      );
      for (let i = candidates.length - 1; i >= 0; i--)
        if (
          versions.get(candidates[i]!.node.id) !==
          candidates[i]!.node.metadata.revision
        )
          candidates.splice(i, 1);
      const fused = fuseMemoryCandidates(candidates);
      const seeds = [
        ...new Set([
          ...fixed.map((n) => n.id),
          ...fused
            .filter((g) => g.some((c) => c.channel === "explicit"))
            .map((g) => g[0]!.node.id),
          ...fused.slice(0, 50).map((g) => g[0]!.node.id),
        ]),
      ];
      candidates.push(...(await options.store.expand(input, seeds)));
      const groups = fuseMemoryCandidates(candidates);
      const current = new Map(
        (
          await options.store.current(
            input,
            groups.map((g) => g[0]!.node.id),
          )
        ).map((n) => [n.id, n]),
      );
      const fixedIds = new Set(fixed.map((n) => n.id));
      const recalled: NativeMemorySnapshot["recalled"] = [];
      const omittedNodeIds: string[] = [];
      let used = 0,
        expressions = 0,
        expressionChars = 0;
      for (const group of groups) {
        const original = group[0]!.node;
        const node = current.get(original.id);
        if (
          !node ||
          fixedIds.has(node.id) ||
          node.metadata.revision !== original.metadata.revision
        )
          continue;
        const expression = node.metadata.kind === "expression";
        const remaining = expression
          ? expressions < 3
            ? 1000 - expressionChars
            : 0
          : 4000 - used;
        if (remaining <= 0) {
          omittedNodeIds.push(node.id);
          continue;
        }
        const chars = Array.from(node.content);
        const content = chars.slice(0, remaining).join("");
        if (expression) {
          expressions++;
          expressionChars += Array.from(content).length;
        } else used += Array.from(content).length;
        recalled.push({
          node: { ...node, content },
          truncated: chars.length > remaining,
          traces: group.map((c) => ({
            channel: c.channel,
            indexVersion:
              c.indexVersion ??
              (c.channel === "text" || c.channel === "fuzzy"
                ? MEMORY_ANALYZER_VERSION
                : "graph:v1"),
            rank: c.rank,
            path: c.path ?? [],
          })),
        });
      }
      return nativeMemorySnapshotSchema.parse({
        ...empty,
        status: "enabled",
        fixed,
        recalled,
        degraded,
        budget: { dynamicCharacters: used + expressionChars, omittedNodeIds },
      });
    },
  };
}
