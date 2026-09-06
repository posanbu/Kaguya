/**
 * 功能概述：提供 Runtime 默认的 `kaguya.memory.lexical-recency` 受控 retrieval strategy，
 * 将联想查询转换成只返回 canonical Memory informationId 的确定性结果。
 * 主要职责：`createMemoryLexicalRecencyRetrievalStrategy` 通过 InformationLedger 的 find/query
 * 端口读取 Memory 和 identity terminal，先按 complete person/scope 过滤，再按 lexical match、
 * occurredAt 和 informationId 稳定排序；不向模块暴露数据库或返回 source 正文。
 * 代码库关系：由 `runtime.ts` 在没有显式替换策略时注入 Core Selector；输入格式由
 * `packages/modules/src/association.ts` 生成，Memory kind 与 identity terminal 由 modules 声明。
 * 将 `retrievalStrategies` 设为空数组可模拟 provider 禁用，association 模块会记录 unavailable。
 * 输入输出与副作用：接收 query、asOf、personInformationId 和 scopeInformationId，返回有序 ID；
 * 读取失败原样交给 association handler 转换为 failed，策略本身不写账、不缓存、不修改原子。
 */
import type {
  InformationLedger,
  InformationRetrievalStrategy,
} from "@kaguya/engine";
import {
  coreMemoryTextInformationKind,
  personContextCompletedInformationKind,
} from "@kaguya/modules";
import { z } from "@kaguya/schema";

const inputSchema = z
  .object({
    query: z.string(),
    queryText: z.string(),
    asOf: z.iso.datetime(),
    personInformationId: z.string().trim().min(1),
    scopeInformationId: z.string().trim().min(1),
  })
  .passthrough();

export function createMemoryLexicalRecencyRetrievalStrategy(
  ledger: InformationLedger,
): InformationRetrievalStrategy {
  return {
    strategyId: "kaguya.memory.lexical-recency",
    async retrieve({ input, limit }) {
      const parsed = inputSchema.parse(input);
      const terms = tokenize(parsed.query);
      if (terms.length === 0) return [];
      const memories = await ledger.find({
        kinds: [coreMemoryTextInformationKind.kind],
        occurredBefore: parsed.asOf,
        limit: 1_000,
      });
      const scoped: MemoryMatch[] = [];
      for (const memory of memories) {
        if (memory.kind !== coreMemoryTextInformationKind.kind) continue;
        if (!(await belongsToIdentity(memory, parsed, ledger))) continue;
        const payload = coreMemoryTextInformationKind.payloadSchema.parse(
          memory.payload,
        );
        const score = lexicalScore(payload.text, terms);
        if (score > 0) {
          scoped.push({ memory, score });
        }
      }
      return scoped
        .sort(
          (left, right) =>
            right.score - left.score ||
            Date.parse(right.memory.occurredAt) -
              Date.parse(left.memory.occurredAt) ||
            left.memory.informationId.localeCompare(right.memory.informationId),
        )
        .slice(0, limit)
        .map(({ memory }) => memory.informationId);
    },
  };
}

interface MemoryMatch {
  readonly memory: import("@kaguya/schema").DeepReadonly<
    import("@kaguya/schema").InformationAtom
  >;
  readonly score: number;
}

async function belongsToIdentity(
  memory: MemoryMatch["memory"],
  input: z.infer<typeof inputSchema>,
  ledger: InformationLedger,
): Promise<boolean> {
  const context = memory.references.find(
    ({ relation }) => relation === "core:context",
  );
  if (context === undefined) return false;
  const related = await ledger.query({
    informationId: context.informationId,
    relation: "core:context",
  });
  return related.some((atom) => {
    if (atom.kind !== personContextCompletedInformationKind.kind) return false;
    const payload = personContextCompletedInformationKind.payloadSchema.parse(
      atom.payload,
    );
    return (
      payload.status === "complete" &&
      payload.personInformationId === input.personInformationId &&
      payload.scopeInformationId === input.scopeInformationId
    );
  });
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((term) => term.length > 1);
}

function lexicalScore(value: string, terms: readonly string[]): number {
  const lower = value.toLowerCase();
  return terms.reduce(
    (score, term) => score + (lower.includes(term) ? 1 : 0),
    0,
  );
}
