import { z } from "zod";

const nonEmptyIdSchema = z.string().trim().min(1);
const settingsSchema = z.record(z.string(), z.unknown());
export const profileIdSchema = z.uuid();

export const aiProviderConfigSchema = z.strictObject({
  id: nonEmptyIdSchema,
  type: nonEmptyIdSchema,
  enabled: z.boolean(),
  baseUrl: z.url().optional(),
  apiKey: z.string().optional(),
  models: z.array(nonEmptyIdSchema),
  settings: settingsSchema,
});

export const aiConfigSchema = z
  .strictObject({
    defaultProviderId: nonEmptyIdSchema.optional(),
    providers: z.array(aiProviderConfigSchema),
  })
  .superRefine((ai, context) => {
    addDuplicateIdIssues(ai.providers, "provider", ["providers"], context);
    if (
      ai.defaultProviderId !== undefined &&
      !ai.providers.some(
        (provider) => provider.id === ai.defaultProviderId && provider.enabled,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultProviderId"],
        message: "defaultProviderId must reference an enabled provider",
      });
    }
  });

export const platformConfigSchema = z.strictObject({
  id: nonEmptyIdSchema,
  type: nonEmptyIdSchema,
  enabled: z.boolean(),
  credentials: settingsSchema,
  settings: settingsSchema,
});

export const pluginConfigSchema = z.strictObject({
  id: nonEmptyIdSchema,
  enabled: z.boolean(),
  settings: settingsSchema,
});

export const userConfigProfileSettingsSchema = z
  .strictObject({
    ai: aiConfigSchema,
    platforms: z.array(platformConfigSchema),
    plugins: z.array(pluginConfigSchema),
  })
  .superRefine((settings, context) => {
    addDuplicateIdIssues(
      settings.platforms,
      "platform",
      ["platforms"],
      context,
    );
    addDuplicateIdIssues(settings.plugins, "plugin", ["plugins"], context);
  });

export const userConfigProfileSchema =
  userConfigProfileSettingsSchema.safeExtend({
    version: z.literal(1),
    id: profileIdSchema,
    name: z.string().trim().min(1),
  });

export const userConfigProfileMetadataSchema = z.strictObject({
  id: profileIdSchema,
  name: z.string().trim().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const userConfigIndexSchema = z
  .strictObject({
    version: z.literal(1),
    defaultProfileId: profileIdSchema,
    profiles: z.array(userConfigProfileMetadataSchema),
    sessionBindings: z.record(z.string(), profileIdSchema),
  })
  .superRefine((index, context) => {
    const profileIds = new Set(index.profiles.map(({ id }) => id));
    const profileNames = new Set<string>();
    if (!profileIds.has(index.defaultProfileId)) {
      context.addIssue({
        code: "custom",
        path: ["defaultProfileId"],
        message: "defaultProfileId must reference a profile",
      });
    }
    for (const [position, profile] of index.profiles.entries()) {
      if (
        index.profiles.findIndex(({ id }) => id === profile.id) !== position
      ) {
        context.addIssue({
          code: "custom",
          path: ["profiles", position, "id"],
          message: "profile IDs must be unique",
        });
      }
      if (profileNames.has(profile.name)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", position, "name"],
          message: "profile names must be unique",
        });
      }
      profileNames.add(profile.name);
    }
    for (const [sessionId, profileId] of Object.entries(
      index.sessionBindings,
    )) {
      if (sessionId.trim().length === 0 || !profileIds.has(profileId)) {
        context.addIssue({
          code: "custom",
          path: ["sessionBindings", sessionId],
          message: "session binding must reference a profile",
        });
      }
    }
  });

function addDuplicateIdIssues(
  entries: readonly { id: string }[],
  kind: string,
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [position, entry] of entries.entries()) {
    if (seen.has(entry.id)) {
      context.addIssue({
        code: "custom",
        path: [...path, position, "id"],
        message: `${kind} IDs must be unique`,
      });
    }
    seen.add(entry.id);
  }
}

export type UserConfigProfile = z.infer<typeof userConfigProfileSchema>;
export type UserConfigProfileSettings = z.infer<
  typeof userConfigProfileSettingsSchema
>;
export type UserConfigProfileMetadata = z.infer<
  typeof userConfigProfileMetadataSchema
>;
export type UserConfigIndex = z.infer<typeof userConfigIndexSchema>;

export type UpdateUserConfigProfileInput = UserConfigProfileSettings & {
  name?: string;
};

export function emptyUserConfigProfileSettings(): UserConfigProfileSettings {
  return {
    ai: { providers: [] },
    platforms: [],
    plugins: [],
  };
}
