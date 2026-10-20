import { z } from "zod";
import { jsonValueSchema } from "./information.js";

/** Provider message contents stay intact. This envelope is independent of situation contract 1.0.0. */
const providerMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(jsonValueSchema)]),
  })
  .catchall(jsonValueSchema);
// The representative branch lets the Information registry verify JSON output.
export const nativeMessageSchema = z
  .union([
    z.strictObject({ role: z.literal("user"), content: z.string() }),
    z.unknown(),
  ])
  .pipe(providerMessageSchema);
const nativeJson = z.union([z.null(), z.unknown()]).pipe(jsonValueSchema);

export const nativeMessagesSchema = z.array(nativeMessageSchema).min(1);
const nativeResponseBase = z
  .object({
    version: z.literal(1),
    messages: nativeMessagesSchema,
    reasoning: z.array(nativeJson),
  })
  .strict();
export const nativeResponseSchema = z.union([
  nativeResponseBase.extend({ providerMetadata: nativeJson }),
  nativeResponseBase,
]);

export type NativeMessage = z.infer<typeof nativeMessageSchema>;
export type NativeResponse = z.infer<typeof nativeResponseSchema>;
