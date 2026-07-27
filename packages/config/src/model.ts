import { z } from "zod";

const nonEmptyIdSchema = z.string().trim().min(1);
const profileIdInnerSchema = z.uuid();
export const profileIdSchema = guardSchemaInput(profileIdInnerSchema);

export type JsonPrimitive = null | string | boolean | number;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const invalidJsonValue = Symbol("invalid-json-value");

export const jsonValueSchema = z
  .unknown()
  .transform<JsonValue>((value, context) => {
    const cloned = safelyCloneJsonValue(value);
    if (cloned === invalidJsonValue) {
      context.addIssue({
        code: "custom",
        message: "Value must contain only JSON-compatible data",
      });
      return z.NEVER;
    }
    return cloned;
  });

export const jsonObjectSchema = z
  .unknown()
  .transform<JsonObject>((value, context) => {
    const cloned = safelyCloneJsonValue(value);
    if (
      cloned === invalidJsonValue ||
      cloned === null ||
      Array.isArray(cloned) ||
      typeof cloned !== "object"
    ) {
      context.addIssue({
        code: "custom",
        message: "Value must be a JSON object",
      });
      return z.NEVER;
    }
    return cloned;
  });

const aiProviderConfigInnerSchema = z
  .strictObject({
    id: nonEmptyIdSchema,
    type: nonEmptyIdSchema,
    enabled: z.boolean(),
    baseUrl: z.url().optional(),
    apiKey: z.string().optional(),
    models: z.array(nonEmptyIdSchema),
    settings: jsonObjectSchema,
  })
  .superRefine((provider, context) => {
    rejectOwnUndefined(provider, "baseUrl", context);
    rejectOwnUndefined(provider, "apiKey", context);
  });

export const aiProviderConfigSchema = guardSchemaInput(
  aiProviderConfigInnerSchema,
);

const aiConfigInnerSchema = z
  .strictObject({
    defaultProviderId: nonEmptyIdSchema.optional(),
    providers: z.array(aiProviderConfigSchema),
  })
  .superRefine((ai, context) => {
    rejectOwnUndefined(ai, "defaultProviderId", context);
    addDuplicateIdIssues(ai.providers, "provider", ["providers"], context);
  });

export const aiConfigSchema = guardSchemaInput(aiConfigInnerSchema);

function rejectOwnUndefined(
  value: object,
  key: string,
  context: z.RefinementCtx,
): void {
  if (Object.hasOwn(value, key) && Reflect.get(value, key) === undefined) {
    context.addIssue({
      code: "custom",
      path: [key],
      message: `${key} must be omitted rather than undefined`,
    });
  }
}

const platformConfigInnerSchema = z.strictObject({
  id: nonEmptyIdSchema,
  type: nonEmptyIdSchema,
  enabled: z.boolean(),
  credentials: jsonObjectSchema,
  settings: jsonObjectSchema,
});

export const platformConfigSchema = guardSchemaInput(platformConfigInnerSchema);

const pluginConfigInnerSchema = z.strictObject({
  id: nonEmptyIdSchema,
  enabled: z.boolean(),
  settings: jsonObjectSchema,
});

export const pluginConfigSchema = guardSchemaInput(pluginConfigInnerSchema);

const userConfigProfileSettingsInnerSchema = z
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

export const userConfigProfileSettingsSchema = guardSchemaInput(
  userConfigProfileSettingsInnerSchema,
);

const userConfigProfileReviewSchema = z.strictObject({
  acknowledgedWarnings: z.array(nonEmptyIdSchema),
});

const userConfigProfileInnerSchema = userConfigProfileSettingsInnerSchema
  .safeExtend({
    version: z.literal(1),
    id: profileIdSchema,
    name: z.string().trim().min(1),
    review: userConfigProfileReviewSchema.optional(),
  })
  .superRefine((profile, context) => {
    rejectOwnUndefined(profile, "review", context);
  });

export const userConfigProfileSchema = guardSchemaInput(
  userConfigProfileInnerSchema,
);

const userConfigProfileMetadataInnerSchema = z.strictObject({
  id: profileIdSchema,
  name: z.string().trim().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const userConfigProfileMetadataSchema = guardSchemaInput(
  userConfigProfileMetadataInnerSchema,
);

const sessionBindingsSchema = z
  .unknown()
  .transform<Record<string, string>>((value, context) => {
    const bindings = safelyCopySessionBindings(value);
    if (bindings === undefined) {
      context.addIssue({
        code: "custom",
        message: "Session bindings must be a plain object",
      });
      return z.NEVER;
    }
    for (const [sessionId, profileId] of Object.entries(bindings)) {
      const parsedProfileId = profileIdSchema.safeParse(profileId);
      if (!parsedProfileId.success) {
        context.addIssue({
          code: "custom",
          path: [sessionId],
          message: "Session binding profile ID is invalid",
        });
        continue;
      }
      bindings[sessionId] = parsedProfileId.data;
    }
    return bindings;
  });

const userConfigIndexInnerSchema = z
  .strictObject({
    version: z.literal(1),
    defaultProfileId: profileIdSchema,
    profiles: z.array(userConfigProfileMetadataSchema),
    sessionBindings: sessionBindingsSchema,
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

export const userConfigIndexSchema = guardSchemaInput(
  userConfigIndexInnerSchema,
);

function guardSchemaInput<T extends z.ZodType>(
  innerSchema: T,
): z.ZodType<z.output<T>, unknown> {
  return z.unknown().transform<z.output<T>>((value, context) => {
    try {
      const parsed = innerSchema.safeParse(value);
      if (parsed.success) {
        return parsed.data;
      }
      for (const issue of parsed.error.issues) {
        context.issues.push({ ...issue, input: undefined });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "Value could not be safely inspected",
      });
    }
    return z.NEVER;
  });
}

function safelyCloneJsonValue(
  value: unknown,
): JsonValue | typeof invalidJsonValue {
  try {
    return cloneJsonValue(value, new WeakSet<object>());
  } catch {
    return invalidJsonValue;
  }
}

function cloneJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
): JsonValue | typeof invalidJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : invalidJsonValue;
  }
  if (typeof value !== "object") {
    return invalidJsonValue;
  }
  if (ancestors.has(value)) {
    return invalidJsonValue;
  }

  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    ) {
      return invalidJsonValue;
    }
    const clone: JsonValue[] = [];
    ancestors.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          return invalidJsonValue;
        }
        const entry = cloneJsonValue(descriptor.value, ancestors);
        if (entry === invalidJsonValue) {
          return invalidJsonValue;
        }
        clone.push(entry);
      }
      return clone;
    } finally {
      ancestors.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidJsonValue;
  }
  const clone = Object.create(null) as JsonObject;
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return invalidJsonValue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return invalidJsonValue;
      }
      const entry = cloneJsonValue(descriptor.value, ancestors);
      if (entry === invalidJsonValue) {
        return invalidJsonValue;
      }
      clone[key] = entry;
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function safelyCopySessionBindings(
  value: unknown,
): Record<string, string> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const bindings = Object.create(null) as Record<string, string>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      ) {
        return undefined;
      }
      bindings[key] = descriptor.value;
    }
    return bindings;
  } catch {
    return undefined;
  }
}

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
