/** Validate recalled raw messages against the frozen turn target and event cutoff. */
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";
import { inboundTextInformationKind } from "./information-kinds.js";
import { sameMessageTarget } from "./heavy/message-quote.js";

export function isMemorySourceInScope(
  atom: DeepReadonly<InformationAtom>,
  target: Parameters<typeof sameMessageTarget>[1],
  occurredBefore: string,
): boolean {
  if (
    atom.kind !== inboundTextInformationKind.kind ||
    Date.parse(atom.occurredAt) > Date.parse(occurredBefore)
  )
    return false;
  const parsed = inboundTextInformationKind.payloadSchema.safeParse(
    atom.payload,
  );
  return parsed.success && sameMessageTarget(parsed.data.source, target);
}
