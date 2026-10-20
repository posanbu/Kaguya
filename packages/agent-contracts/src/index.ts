/** 从 Kaguya 已接线的 Light 校验与 Memory 图协议提取，不包含形成算法或宿主 I/O。 */
import { z } from "zod";
export const lightTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z
    .object({
      kind: z.enum(["group", "private"]),
      reference: z.string().min(1).max(100),
      instruction: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unresolved"),
      reason: z.enum([
        "ambiguous",
        "unrecognized",
        "unreachable",
        "not-found",
        "unauthorized",
      ]),
    })
    .strict(),
]);
export const lightActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("message"),
      reason: z.enum(["respond", "contribute"]),
      target: lightTargetSchema.default({ kind: "current" }),
    })
    .strict(),
  z
    .object({
      action: z.literal("wait"),
      reason: z.enum(["await-more-context", "avoid-interruption"]),
      waitSeconds: z.number().int().min(5).max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal("silent"),
      reason: z.enum([
        "no-response-needed",
        "already-addressed",
        "avoid-interruption",
        "topic-expired",
      ]),
    })
    .strict(),
]);
/** 校验参与动作与等待预算。 */
export function lightActionSchemaForTurn(turn: {
  readonly inputs: readonly unknown[];
  readonly attempt: number;
  readonly totalWaitBudget: number;
}) {
  if (turn.inputs.length === 0)
    throw new Error("Light requires at least one frozen input");
  return turn.attempt < turn.totalWaitBudget
    ? lightActionSchema
    : z.discriminatedUnion("action", [
        lightActionSchema.options[0],
        lightActionSchema.options[2],
      ]);
}

export * from "./memory-graph.js";
