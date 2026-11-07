/**
 * 功能概述：在 situation 冻结时选取原生历史及实际工具结果，保持 call/result 成对。
 * 同一 completed 的调用结果受同一登记上界约束；未知结果保留，旧闭合片段采用有界尾部。
 * Heavy 消费这些不可变 ID，不在下一次模型 dispatch 时另行读取新的事实。
 */
import { defineInformationSelector } from "@kaguya/sdk";
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";

/** Freeze the native history with the evidence, rather than reselecting it at dispatch. */
export const situationHistorySelector = defineInformationSelector({
  selectorId: "agent.situation.native-history",
  select: async ({ sourceAtom, ledger }) => {
    const selected = new Map<string, DeepReadonly<InformationAtom>>();
    const add = (atoms: readonly DeepReadonly<InformationAtom>[]) => {
      for (const atom of atoms) selected.set(atom.informationId, atom);
      return atoms;
    };
    const completed: DeepReadonly<InformationAtom>[] = [];
    let afterInformationId: string | undefined;
    for (;;) {
      const page = await ledger.find({
        kinds: ["core.model.task.completed"],
        payloadContains: { taskId: "agent.heavy.respond" },
        throughInformationId: sourceAtom.informationId,
        registrationOrder: true,
        order: "asc",
        limit: 1000,
        ...(afterInformationId ? { afterInformationId } : {}),
      });
      completed.push(...page);
      if (page.length < 1000) break;
      afterInformationId = page.at(-1)!.informationId;
    }
    add(completed);
    for (const atom of completed) {
      if (atom.payload.generationKind === "tool-calls")
        add(
          await ledger.find({
            kinds: ["agent.heavy.tool.result.v1"],
            payloadContains: {
              modelCompletedInformationId: atom.informationId,
            },
            throughInformationId: sourceAtom.informationId,
            registrationOrder: true,
            limit: 128,
          }),
        );
      if (
        (atom.payload.output as { action?: string } | undefined)?.action ===
        "recall"
      ) {
        const requests = add(
          await ledger.related({
            from: [atom.informationId],
            relation: "core:caused-by",
            direction: "incoming",
            limit: 20,
          }),
        );
        for (const request of requests.filter(
          (a) => a.kind === "agent.heavy.recall.requested",
        )) {
          const results = await ledger.related({
            from: [request.informationId],
            relation: "core:caused-by",
            direction: "incoming",
            limit: 20,
          });
          add(
            await ledger.find({
              informationIds: results.map((a) => a.informationId),
              throughInformationId: sourceAtom.informationId,
              registrationOrder: true,
              limit: 20,
            }),
          );
        }
      }
      const deliveries = add(
        await ledger.find({
          kinds: ["core.delivery.requested"],
          payloadContains: {
            speech: { completedInformationId: atom.informationId },
          },
          throughInformationId: sourceAtom.informationId,
          registrationOrder: true,
          limit: 2,
        }),
      );
      for (const delivery of deliveries)
        add(
          await ledger.find({
            informationIds: (
              await ledger.related({
                from: [delivery.informationId],
                relation: "core:status-of",
                direction: "incoming",
                limit: 10,
              })
            ).map((a) => a.informationId),
            throughInformationId: sourceAtom.informationId,
            registrationOrder: true,
            limit: 10,
          }),
        );
      const source = add(
        await ledger.find({
          informationIds: [String(atom.payload.sourceInformationId)],
          limit: 1,
        }),
      )[0];
      const contextId = (
        source?.payload.turn as { contextInformationId?: string } | undefined
      )?.contextInformationId;
      if (contextId) {
        await ledger.find({ informationIds: [contextId], limit: 1 });
        const backgrounds = await ledger.related({
          from: [contextId],
          relation: "core:uses-context",
          direction: "incoming",
          limit: 1000,
        });
        add(
          backgrounds.filter(
            (a) => a.kind === "agent.router.conversation.context.frozen",
          ),
        );
      }
      const candidateId = (
        source?.payload.turn as { candidateInformationId?: string } | undefined
      )?.candidateInformationId;
      if (!candidateId) continue;
      add(await ledger.find({ informationIds: [candidateId], limit: 1 }));
      const related = await ledger.related({
        from: [candidateId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 1000,
      });
      const terminals = add(
        await ledger.find({
          informationIds: related.map((a) => a.informationId),
          throughInformationId: sourceAtom.informationId,
          registrationOrder: true,
          order: "asc",
          limit: 1000,
        }),
      );
      for (const terminal of terminals) {
        if (typeof terminal.payload.deliveryTerminalInformationId === "string")
          add(
            await ledger.find({
              informationIds: [terminal.payload.deliveryTerminalInformationId],
              throughInformationId: sourceAtom.informationId,
              limit: 1,
            }),
          );
      }
    }
    add(
      await ledger.find({
        kinds: ["agent.situation.frozen"],
        throughInformationId: sourceAtom.informationId,
        registrationOrder: true,
        order: "desc",
        limit: 1,
      }),
    );
    // Keep a bounded closed tail and every unresolved action. Original rows remain queryable.
    const retained = new Set<string>();
    for (const atom of selected.values())
      if (atom.kind === "agent.situation.frozen")
        retained.add(atom.informationId);
    for (const [index, result] of completed.entries()) {
      const source = selected.get(String(result.payload.sourceInformationId));
      const candidateId = (
        source?.payload.turn as { candidateInformationId?: string } | undefined
      )?.candidateInformationId;
      if (!candidateId) continue;
      const terminals = [...selected.values()].filter(
        (a) =>
          a.payload.candidateInformationId === candidateId &&
          [
            "completed",
            "silent",
            "waiting",
            "failed",
            "superseded",
            "interrupted",
          ].some((status) => a.kind === `agent.router.turn.${status}`),
      );
      const terminal = terminals[0];
      const delivery = [...selected.values()].find(
        (a) =>
          a.kind === "core.delivery.requested" &&
          (a.payload.speech as { completedInformationId?: string } | undefined)
            ?.completedInformationId === result.informationId,
      );
      const receipt = delivery
        ? [...selected.values()].find(
            (a) =>
              (a.kind === "core.delivery.delivered" ||
                a.kind === "core.delivery.failed") &&
              a.references.some(
                (r) =>
                  r.relation === "core:status-of" &&
                  r.informationId === delivery.informationId,
              ),
          )
        : selected.get(String(terminal?.payload.deliveryTerminalInformationId));
      const calls = new Set<string>();
      const native = result.payload.native as
        { messages?: { content: unknown }[] } | undefined;
      for (const message of native?.messages ?? [])
        if (Array.isArray(message.content))
          for (const part of message.content) {
            if (part?.type === "tool-call") calls.add(part.toolCallId);
            if (part?.type === "tool-result") calls.delete(part.toolCallId);
          }
      const toolResults = [...selected.values()].filter(
        (a) =>
          a.kind === "agent.heavy.tool.result.v1" &&
          a.payload.modelCompletedInformationId === result.informationId,
      );
      for (const r of toolResults) calls.delete(String(r.payload.toolCallId));
      const toolUnconfirmed = toolResults.some(
        (r) =>
          ["unknown", "partial", "output-budget"].includes(
            String((r.payload.value as any)?.status),
          ) ||
          ["fenced", "unconfirmed"].includes(
            String((r.payload.value as any)?.environmentValidation),
          ),
      );
      const recall =
        (result.payload.output as { action?: string } | undefined)?.action ===
        "recall";
      const recallRequest = [...selected.values()].find(
        (a) =>
          a.kind === "agent.heavy.recall.requested" &&
          a.references.some(
            (r) =>
              r.relation === "core:caused-by" &&
              r.informationId === result.informationId,
          ),
      );
      const recallResult = [...selected.values()].find(
        (a) =>
          a.kind === "agent.heavy.recall.completed" &&
          a.references.some(
            (r) =>
              r.relation === "core:caused-by" &&
              r.informationId === recallRequest?.informationId,
          ),
      );
      const unresolved = recall
        ? !recallResult
        : !terminal ||
          terminal.kind.endsWith(".waiting") ||
          receipt?.payload.outcome === "unknown" ||
          calls.size > 0 ||
          toolUnconfirmed;
      if (index < completed.length - 64 && !unresolved) continue;
      const contextId = (
        source?.payload.turn as { contextInformationId?: string } | undefined
      )?.contextInformationId;
      for (const background of selected.values())
        if (
          background.kind === "agent.router.conversation.context.frozen" &&
          background.references.some(
            (r) =>
              r.relation === "core:uses-context" &&
              r.informationId === contextId,
          )
        )
          retained.add(background.informationId);
      for (const id of [
        result.informationId,
        ...toolResults.map((a) => a.informationId),
        recallRequest?.informationId,
        recallResult?.informationId,
        source?.informationId,
        candidateId,
        ...terminals.map((a) => a.informationId),
        receipt?.informationId,
        delivery?.informationId,
      ])
        if (id && selected.has(id)) retained.add(id);
    }
    return [
      ...completed.map((a) => a.informationId),
      ...selected.keys(),
    ].filter((id, index, all) => retained.has(id) && all.indexOf(id) === index);
  },
});
