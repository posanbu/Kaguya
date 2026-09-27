/** 人物画像的持久化与管理边界。Memory 来源仅预留数据契约，当前管理端只接受手动条目。 */
import { z } from "zod";
import { informationIdSchema } from "./information.js";

export const PERSON_PROFILE_REVISION_KIND =
  "memory.identity.person.profile.revision";
export const personProfileSectionKeys = [
  "identity",
  "relationship",
  "stableFacts",
  "preferences",
  "recentInteractions",
  "uncertainNotes",
] as const;
export type PersonProfileSectionKey = (typeof personProfileSectionKeys)[number];

const entryShape = {
  id: z.uuid(),
  text: z.string().trim().min(1).max(500),
};
export const manualPersonProfileEntrySchema = z
  .object({
    ...entryShape,
    source: z.literal("manual"),
    evidenceInformationIds: z.array(informationIdSchema).max(0),
  })
  .strict();
export const extractedPersonProfileEntrySchema = z
  .object({
    ...entryShape,
    source: z.literal("memory_extracted"),
    evidenceInformationIds: z.array(informationIdSchema).min(1).max(10),
  })
  .strict();
export const personProfileEntrySchema = z.discriminatedUnion("source", [
  manualPersonProfileEntrySchema,
  extractedPersonProfileEntrySchema,
]);

function sectionsOf<T extends z.ZodType>(entry: T) {
  const items = z.array(entry).max(20);
  return z
    .object({
      identity: items,
      relationship: items,
      stableFacts: items,
      preferences: items,
      recentInteractions: items,
      uncertainNotes: items,
    })
    .strict();
}
export const personProfileSectionsSchema = sectionsOf(personProfileEntrySchema);
export const manualPersonProfileSectionsSchema = sectionsOf(
  manualPersonProfileEntrySchema,
);
export type PersonProfileSections = z.infer<typeof personProfileSectionsSchema>;
export type ManualPersonProfileSections = z.infer<
  typeof manualPersonProfileSectionsSchema
>;

const nameSchema = z.string().trim().min(1).max(100);
export const personProfileMetadataSchema = z
  .object({
    primaryName: nameSchema.nullable(),
    aliases: z
      .array(manualPersonProfileEntrySchema.extend({ text: nameSchema }))
      .max(8),
    nameReason: z.string().trim().max(500),
    knownStatus: z.enum(["unset", "known", "unknown"]),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const alias of value.aliases) {
      const normalized = alias.text.toLocaleLowerCase();
      if (
        normalized === value.primaryName?.toLocaleLowerCase() ||
        seen.has(normalized)
      )
        context.addIssue({ code: "custom", message: "Duplicate person alias" });
      seen.add(normalized);
    }
  });
export type PersonProfileMetadata = z.infer<typeof personProfileMetadataSchema>;

export function emptyPersonProfileMetadata(): PersonProfileMetadata {
  return {
    primaryName: null,
    aliases: [],
    nameReason: "",
    knownStatus: "unset",
  };
}

export const personProfileRevisionPayloadSchema = z
  .object({
    personInformationId: informationIdSchema,
    revision: z.number().int().positive(),
    sections: personProfileSectionsSchema,
    metadata: personProfileMetadataSchema.optional(),
    previousRevisionInformationId: informationIdSchema.nullable(),
  })
  .strict();
export type PersonProfileRevisionPayload = z.infer<
  typeof personProfileRevisionPayloadSchema
>;
export const personProfileSaveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sections: manualPersonProfileSectionsSchema,
    metadata: personProfileMetadataSchema.optional(),
  })
  .strict();

export const personProfileViewSchema = z
  .object({
    personInformationId: informationIdSchema,
    revision: z.number().int().nonnegative(),
    activeRevision: z.number().int().nonnegative(),
    sections: personProfileSectionsSchema,
    metadata: personProfileMetadataSchema,
    activeName: z.string(),
    activeKnownStatus: z.enum(["unset", "known", "unknown"]),
    previewName: z.string(),
    preview: z.string(),
    restartRequired: z.boolean(),
    effect: z.literal("restart_required"),
  })
  .strict();
export type PersonProfileView = z.infer<typeof personProfileViewSchema>;

export function emptyPersonProfileSections(): ManualPersonProfileSections {
  return {
    identity: [],
    relationship: [],
    stableFacts: [],
    preferences: [],
    recentInteractions: [],
    uncertainNotes: [],
  };
}
