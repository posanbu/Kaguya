import { z } from "@kaguya/schema";
export const embeddingIdentitySchema = z
  .object({
    modelId: z.string().min(1),
    revision: z.string().min(1),
    dimensions: z.number().int().min(1).max(16000),
  })
  .strict();
export type EmbeddingIdentity = Readonly<
  z.infer<typeof embeddingIdentitySchema>
>;
export interface EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  embed(text: string, signal: AbortSignal): Promise<readonly number[]>;
}
export function validateEmbedding(
  vector: readonly number[],
  identity: EmbeddingIdentity,
): readonly number[] {
  embeddingIdentitySchema.parse(identity);
  if (
    vector.length !== identity.dimensions ||
    !vector.every(Number.isFinite) ||
    vector.every((value) => value === 0)
  )
    throw new Error("Invalid embedding vector");
  return vector;
}
export function embeddingIdentityKey(identity: EmbeddingIdentity): string {
  const parsed = embeddingIdentitySchema.parse(identity);
  return JSON.stringify([parsed.modelId, parsed.revision, parsed.dimensions]);
}
