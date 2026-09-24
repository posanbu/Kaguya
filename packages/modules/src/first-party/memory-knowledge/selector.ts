/**
 * 人工录入在全局范围按关键词召回；原始平台消息仍逐条校验聊天范围，不因全局记忆而跨会话读取。
 * 功能概述：在规划前以 canonical scope 查询知识记忆，再验证原始消息的来源范围与时间。
 * 主要职责：selectKnowledgeMemory 在同一规范范围内读取最近四位发言者，按名称召回角色设定；
 * 多输入查询、话题与人物路径共享固定预算，独立路径失败不吞掉其他已授权证据。
 * 已解析人物使用实体导航选近期原文，缺少人物时才用有界关键词，避免拿整条问句做精确子串检索。
 * isMemorySourceInScope 对重载原始证据执行独立范围校验，可供 Composer 检查冻结的记忆。
 * 代码库关系：Heartflow 合并本路径与 sparse 旁路并冻结原始 ID；Core 的可读 ID 授权不替代业务范围检查。
 * 输入输出与副作用：仅有界读取账本与命名检索；未启用、身份不一致及检索故障返回空，不扩张在线权限。
 */
import { MEMORY_KNOWLEDGE_RETRIEVAL_STRATEGY_ID } from "@kaguya/memory";
import {
  USER_STATEMENT_KIND,
  GLOBAL_MEMORY_SCOPE_ID,
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

import {
  buildRecallQuery,
  mergeRecallLanes,
} from "../heartflow/recall-query.js";

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
      parsed.data.scopeInformationId === GLOBAL_MEMORY_SCOPE_ID &&
      parsed.data.scope.platform === "web" &&
      parsed.data.scope.adapterId === "web.ui.main" &&
      parsed.data.scope.destination.kind === "web" &&
      atom.references.some(
        (r) =>
          r.relation === "agent:scope" &&
          r.informationId === parsed.data.scopeInformationId,
      )
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
    readonly agentNames?: readonly string[];
  },
): Promise<readonly DeepReadonly<InformationAtom>[]> {
  if (input.inbounds.length === 0 || input.limit <= 0) return [];
  let globalMemory: readonly DeepReadonly<InformationAtom>[] = [];
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
    const query = buildRecallQuery(
      input.inbounds.map((a) => String(a.payload.text ?? "")),
    );
    const recallManual = async (query: string, settingsOnly = false) => {
      if (!query) return [];
      const found = await ledger.retrieve({
        strategyId: MEMORY_KNOWLEDGE_RETRIEVAL_STRATEGY_ID,
        input: {
          scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
          query,
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
            isMemorySourceInScope(a, first, input.occurredBefore) &&
            (!settingsOnly || a.payload.sourceType === "character_setting"),
        )
        .slice(0, settingsOnly ? Math.min(2, input.limit) : input.limit);
    };
    const names = [
      ...new Set(
        input.agentNames?.map((name) => name.trim()).filter(Boolean) ?? [],
      ),
    ].slice(0, 3);
    const manualLanes = await Promise.all([
      recallManual(query).catch(() => []),
      ...names.map((name) =>
        recallManual(Array.from(name).slice(0, 128).join(""), true).catch(
          () => [],
        ),
      ),
    ]);
    const settings = mergeRecallLanes(manualLanes.slice(1), 2);
    globalMemory = mergeRecallLanes([manualLanes[0]!, settings], input.limit);
    if (first.destination.kind === "web") return globalMemory;
    const speakers = new Map<string, DeepReadonly<InformationAtom>>();
    for (const atom of [...input.inbounds].reverse()) {
      const sender = inboundTextInformationKind.payloadSchema.parse(
        atom.payload,
      ).source.senderId;
      if (!speakers.has(sender)) speakers.set(sender, atom);
      if (speakers.size === 4) break;
    }
    const participants = [...speakers.values()];
    const excluded = new Set(input.inbounds.map((atom) => atom.informationId));
    const entities = new Set<string>();
    const participantLanes: (readonly DeepReadonly<InformationAtom>[])[] = [];
    for (const participant of participants) {
      // 一个参与者的身份/检索故障不吞掉其他参与者已经可用的证据。
      try {
        const terminals = (
          await ledger.related({
            from: [participant.informationId],
            relation: "core:status-of",
            direction: "incoming",
            limit: 10,
          })
        ).filter(
          (atom) => atom.kind === personContextCompletedInformationKind.kind,
        );
        if (terminals.length !== 1) continue;
        const identity = terminals[0]!.payload;
        if (
          identity.status !== "complete" ||
          identity.scopeMode !== "canonical" ||
          typeof identity.scopeInformationId !== "string"
        )
          continue;
        const scopeInformationId = identity.scopeInformationId;
        const scope = (
          await ledger.find({
            informationIds: [scopeInformationId],
            kinds: [chatScopeEntityInformationKind.kind],
            limit: 1,
          })
        )[0];
        const parsed = chatScopeEntityInformationKind.payloadSchema.safeParse(
          scope?.payload,
        );
        if (
          scope?.informationId !== scopeInformationId ||
          !parsed.success ||
          parsed.data.scopeMode !== "canonical" ||
          !sameScope(parsed.data, first)
        )
          continue;
        const entityInformationId =
          typeof identity.personInformationId === "string"
            ? identity.personInformationId
            : undefined;
        const key = `${scopeInformationId}:${entityInformationId ?? "query"}`;
        if (entities.has(key)) continue;
        entities.add(key);
        if (!entityInformationId && !query) continue;
        const recalled = await ledger.retrieve({
          strategyId: MEMORY_KNOWLEDGE_RETRIEVAL_STRATEGY_ID,
          input: {
            scopeInformationId,
            ...(entityInformationId ? { entityInformationId } : { query }),
            occurredBefore: input.occurredBefore,
            recordedBefore: input.recordedBefore,
          },
          limit: input.limit,
        });
        participantLanes.push(
          recalled
            .filter(
              (atom) =>
                !excluded.has(atom.informationId) &&
                isMemorySourceInScope(atom, first, input.occurredBefore),
            )
            .slice(0, input.limit),
        );
      } catch {
        /* 可选背景失败时保留其他召回路径。 */
      }
    }
    return mergeRecallLanes(
      [manualLanes[0]!, settings, ...participantLanes],
      input.limit,
    );
  } catch {
    return globalMemory;
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
