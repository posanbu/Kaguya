/**
 * 人工记忆使用同范围有界关键词召回；WebUI 共用范围仅接受 management 录入片段，不读取其他会话聊天记录。
 * 功能概述：在规划前以 canonical scope 查询知识记忆，再验证原始消息的来源范围与时间。
 * 主要职责：selectKnowledgeMemory 从当前入站的身份终态解析单个规范范围；
 * 已解析人物使用实体导航选近期原文，缺少人物时才用有界关键词，避免拿整条问句做精确子串检索。
 * isMemorySourceInScope 对重载原始证据执行独立范围校验，可供 Composer 检查冻结的记忆。
 * 代码库关系：Heartflow 合并本路径与 sparse 旁路并冻结原始 ID；Core 的可读 ID 授权不替代业务范围检查。
 * 输入输出与副作用：仅有界读取账本与命名检索；未启用、身份不一致及检索故障返回空，不扩张在线权限。
 */
import { MEMORY_KNOWLEDGE_RETRIEVAL_STRATEGY_ID } from "@kaguya/memory";
import {
  USER_STATEMENT_KIND,
  WEB_MEMORY_SCOPE_ID,
  userStatementPayloadSchema,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import type { InformationSelectorLedger } from "@kaguya/sdk";
import {
  chatScopeEntityInformationKind,
  inboundTextInformationKind,
  personContextCompletedInformationKind,
} from "../information-kinds.js";

type Scope = {
  readonly platform: string;
  readonly adapterId: string;
  readonly destination:
    | { readonly kind: "group"; readonly groupId: string }
    | { readonly kind: "private"; readonly userId: string }
    | { readonly kind: "web" };
};

export function isMemorySourceInScope(
  atom: DeepReadonly<InformationAtom>,
  scope: Scope,
  occurredBefore: string,
): boolean {
  if (atom.kind === USER_STATEMENT_KIND) {
    const parsed = userStatementPayloadSchema.safeParse(atom.payload);
    return (
      parsed.success &&
      Date.parse(atom.occurredAt) <= Date.parse(occurredBefore) &&
      sameScope(parsed.data.scope, scope) &&
      atom.references.some(
        (r) =>
          r.relation === "agent:scope" &&
          r.informationId === parsed.data.scopeInformationId,
      ) &&
      (scope.destination.kind !== "web" ||
        parsed.data.scopeInformationId === WEB_MEMORY_SCOPE_ID)
    );
  }
  if (
    atom.kind !== inboundTextInformationKind.kind ||
    !(Date.parse(atom.occurredAt) <= Date.parse(occurredBefore))
  )
    return false;
  const parsed = inboundTextInformationKind.payloadSchema.safeParse(
    atom.payload,
  );
  return parsed.success && sameScope(parsed.data.source, scope);
}

export async function selectKnowledgeMemory(
  ledger: InformationSelectorLedger,
  input: {
    readonly inbounds: readonly DeepReadonly<InformationAtom>[];
    readonly occurredBefore: string;
    readonly recordedBefore: string;
    readonly limit: number;
  },
): Promise<readonly DeepReadonly<InformationAtom>[]> {
  if (input.inbounds.length === 0 || input.limit <= 0) return [];
  try {
    const first = inboundTextInformationKind.payloadSchema.parse(
      input.inbounds[0]!.payload,
    ).source;
    if (
      input.inbounds.some(
        (atom) => !isMemorySourceInScope(atom, first, input.occurredBefore),
      )
    )
      return [];
    const manualQuery = input.inbounds
      .map((a) => String(a.payload.text ?? ""))
      .join("\n");
    const recallManual = async (scopeInformationId: string) => {
      const found = await ledger.retrieve({
        strategyId: MEMORY_KNOWLEDGE_RETRIEVAL_STRATEGY_ID,
        input: {
          scopeInformationId,
          query: Array.from(manualQuery).slice(0, 512).join(""),
          userStatementsOnly: true,
          occurredBefore: input.occurredBefore,
          recordedBefore: input.recordedBefore,
        },
        limit: input.limit,
      });
      return found
        .filter(
          (a) =>
            a.kind === USER_STATEMENT_KIND &&
            a.payload.scopeInformationId === scopeInformationId &&
            isMemorySourceInScope(a, first, input.occurredBefore),
        )
        .slice(0, input.limit);
    };
    if (first.destination.kind === "web")
      return await recallManual(WEB_MEMORY_SCOPE_ID);
    // 原生范围已对整批输入核验；只解析首条身份，避免每条输入增加一次查询。
    const terminals = (
      await ledger.related({
        from: [input.inbounds[0]!.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 10,
      })
    ).filter(
      (atom) => atom.kind === personContextCompletedInformationKind.kind,
    );
    if (terminals.length !== 1) return [];
    const identity = terminals[0]!.payload;
    if (
      identity.status !== "complete" ||
      identity.scopeMode !== "canonical" ||
      typeof identity.scopeInformationId !== "string"
    )
      return [];
    const scopeInformationId = identity.scopeInformationId;
    const entityInformationId =
      typeof identity.personInformationId === "string"
        ? identity.personInformationId
        : undefined;
    const scopes = await ledger.find({
      informationIds: [scopeInformationId],
      kinds: [chatScopeEntityInformationKind.kind],
      limit: 1,
    });
    const scope = scopes[0];
    const parsed = chatScopeEntityInformationKind.payloadSchema.safeParse(
      scope?.payload,
    );
    if (
      scope?.informationId !== scopeInformationId ||
      !parsed.success ||
      parsed.data.scopeMode !== "canonical" ||
      !sameScope(parsed.data, first)
    )
      return [];
    const query = Array.from(
      input.inbounds
        .map(
          (atom) =>
            inboundTextInformationKind.payloadSchema.parse(atom.payload).text,
        )
        .join("\n")
        .trim(),
    )
      .slice(0, 512)
      .join("");
    const recalled = await ledger.retrieve({
      strategyId: MEMORY_KNOWLEDGE_RETRIEVAL_STRATEGY_ID,
      input: {
        scopeInformationId,
        ...(entityInformationId
          ? { entityInformationId }
          : query
            ? { query }
            : {}),
        occurredBefore: input.occurredBefore,
        recordedBefore: input.recordedBefore,
      },
      limit: input.limit,
    });
    const excluded = new Set(input.inbounds.map((atom) => atom.informationId));
    const selected = new Map<string, DeepReadonly<InformationAtom>>();
    for (const atom of await recallManual(scopeInformationId))
      selected.set(atom.informationId, atom);
    for (const atom of recalled) {
      if (selected.size >= input.limit) break;
      if (
        !excluded.has(atom.informationId) &&
        isMemorySourceInScope(atom, first, input.occurredBefore)
      )
        selected.set(atom.informationId, atom);
      if (selected.size >= input.limit) break;
    }
    return [...selected.values()];
  } catch {
    return [];
  }
}

function sameScope(left: Scope, right: Scope): boolean {
  if (left.platform !== right.platform || left.adapterId !== right.adapterId)
    return false;
  const a = left.destination;
  const b = right.destination;
  return (
    (a.kind === "group" && b.kind === "group" && a.groupId === b.groupId) ||
    (a.kind === "private" && b.kind === "private" && a.userId === b.userId) ||
    (a.kind === "web" && b.kind === "web")
  );
}
