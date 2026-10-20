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
      const source = add(
        await ledger.find({
          informationIds: [String(atom.payload.sourceInformationId)],
          limit: 1,
        }),
      )[0];
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
      const receipt = selected.get(
        String(terminal?.payload.deliveryTerminalInformationId),
      );
      const calls = new Set<string>();
      const native = result.payload.native as
        { messages?: { content: unknown }[] } | undefined;
      for (const message of native?.messages ?? [])
        if (Array.isArray(message.content))
          for (const part of message.content) {
            if (part?.type === "tool-call") calls.add(part.toolCallId);
            if (part?.type === "tool-result") calls.delete(part.toolCallId);
          }
      const unresolved =
        !terminal ||
        terminal.kind.endsWith(".waiting") ||
        receipt?.payload.outcome === "unknown" ||
        calls.size > 0;
      if (index < completed.length - 64 && !unresolved) continue;
      for (const id of [
        result.informationId,
        source?.informationId,
        candidateId,
        ...terminals.map((a) => a.informationId),
        receipt?.informationId,
      ])
        if (id && selected.has(id)) retained.add(id);
    }
    return [
      ...completed.map((a) => a.informationId),
      ...selected.keys(),
    ].filter((id, index, all) => retained.has(id) && all.indexOf(id) === index);
  },
});
