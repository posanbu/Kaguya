/**
 * 功能概述：定义开发者控制台的版本化只读 DTO，与内部 Ledger 和模块实例隔离。
 * 主要职责：各 inspection*Schema 校验 Module、Atom 摘要/详情、游标页和有界 Flow；
 * 对应类型供服务端投影与 WebUI 共享，领域视图/机制由 Manifest 声明；presentation 展示安全字段。
 * inspectionStorageSchema 区分真实存储不可用与空页，游标不包含内容。
 * 代码库关系：由 schema/index.ts 导出，server/inspection.ts 产出，Web API 校验后展示。
 * 输入输出与副作用：仅声明 JSON wire contract，无 I/O；详情 payload 必须由服务端先脱敏。
 */
import { z } from "zod";
import { jsonValueSchema } from "./information.js";

const inspectionFieldPathSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/u);
const surfaceFieldSchema = z.object({
  path: inspectionFieldPathSchema,
  label: z.string().trim().min(1),
});
const surfaceRelationSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  viewId: z.string().trim().min(1),
  kinds: z.array(z.string().trim().min(1)).min(1),
  match: z.object({
    source: z.enum(["entity-id", "entity-key"]),
    field: inspectionFieldPathSchema,
  }),
  via: z
    .object({
      viewId: z.string().trim().min(1),
      kinds: z.array(z.string().trim().min(1)).min(1),
      matchField: inspectionFieldPathSchema,
      selectField: inspectionFieldPathSchema,
    })
    .optional(),
  presentation: z.enum([
    "field-grid",
    "relation-list",
    "timeline",
    "record-table",
    "relationship-graph",
  ]),
  fields: z.array(surfaceFieldSchema).min(1),
  limit: z.number().int().min(1).max(50).default(20),
});
const surfaceComponentSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("status-summary"),
    area: z.string().trim().min(1),
    viewId: z.string().trim().min(1),
    kinds: z.array(z.string().trim().min(1)).min(1),
    statusField: inspectionFieldPathSchema,
    windowHours: z.number().int().min(1).max(168),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("entity-browser"),
    area: z.string().trim().min(1),
    viewId: z.string().trim().min(1),
    entityKind: z.string().trim().min(1),
    entityKeyField: inspectionFieldPathSchema,
    activity: z.object({
      viewId: z.string().trim().min(1),
      kinds: z.array(z.string().trim().min(1)).min(1),
      entityKeyField: inspectionFieldPathSchema,
    }),
    titleFields: z.array(surfaceFieldSchema).min(1),
    searchFields: z
      .array(
        z.object({
          viewId: z.string().trim().min(1),
          kind: z.string().trim().min(1),
          path: inspectionFieldPathSchema,
        }),
      )
      .min(1),
    platform: z.object({
      viewId: z.string().trim().min(1),
      kind: z.string().trim().min(1),
      field: inspectionFieldPathSchema,
      entityKeyField: inspectionFieldPathSchema,
    }),
    status: z.object({
      viewId: z.string().trim().min(1),
      kinds: z.array(z.string().trim().min(1)).min(1),
      entityField: inspectionFieldPathSchema,
      statusField: inspectionFieldPathSchema,
    }),
    relations: z.array(surfaceRelationSchema).min(1),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("mechanism-steps"),
    area: z.string().trim().min(1),
  }),
]);
export const moduleInspectionSurfaceSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  layout: z.object({
    type: z.enum(["stack", "sections", "master-detail", "responsive-grid"]),
    areas: z.array(z.string().trim().min(1)).min(1),
  }),
  components: z.array(surfaceComponentSchema).min(1),
});
export type ModuleInspectionSurfaceV1 = z.infer<
  typeof moduleInspectionSurfaceSchema
>;

/** 模块自行声明领域视图；服务端只接受注册的视图和字段路径，不执行客户端表达式。 */
export const moduleInspectionSchema = z.object({
  mechanism: z.array(z.string()),
  views: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      kinds: z.array(z.string()),
      fields: z.array(z.object({ path: z.string(), label: z.string() })),
    }),
  ),
  storage: z.enum(["memory", "vectors"]).optional(),
  surface: moduleInspectionSurfaceSchema.optional(),
});
export type ModuleInspection = z.infer<typeof moduleInspectionSchema>;
export const inspectionPresentationSchema = z.object({
  title: z.string(),
  status: z.string().optional(),
  fields: z.array(z.object({ label: z.string(), value: jsonValueSchema })),
});

const kind = z.object({
  kind: z.string(),
  displayName: z.string(),
  description: z.string(),
});
const capability = z.object({ id: z.string(), apiVersion: z.number() });
export const inspectionModuleSchema = z.object({
  definitionId: z.string(),
  inspection: moduleInspectionSchema.optional(),
  displayName: z.string(),
  summary: z.string(),
  description: z.string(),
  moduleVersion: z.string(),
  protocolVersion: z.number(),
  settingsSchemaFingerprint: z.string(),
  consumes: z.array(kind),
  produces: z.array(kind),
  selectors: z.array(z.string()),
  promptRenderers: z.array(
    z.object({
      rendererId: z.string(),
      displayName: z.string(),
      description: z.string(),
      kinds: z.array(z.string()),
    }),
  ),
  diagnostics: z.array(z.string()),
  requires: z.array(capability),
  provides: z.array(capability),
  bindings: z.array(
    z.object({
      instanceId: z.string(),
      capabilities: z.array(
        z.object({ capabilityId: z.string(), provider: z.string() }),
      ),
    }),
  ),
});
export const inspectionModulesSchema = z.object({
  version: z.literal(1),
  modules: z.array(inspectionModuleSchema),
});
export const inspectionAtomSchema = z.object({
  informationId: z.string(),
  kind: z.string(),
  occurredAt: z.string(),
  source: z.string(),
  presentation: inspectionPresentationSchema.optional(),
});
const reference = z.object({ relation: z.string(), informationId: z.string() });
export const inspectionPageSchema = z.object({
  version: z.literal(1),
  items: z.array(inspectionAtomSchema),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
});
export const inspectionDetailSchema = z.object({
  version: z.literal(1),
  atom: inspectionAtomSchema.extend({
    payload: jsonValueSchema,
    references: z.array(reference),
  }),
  referencedBy: z.array(inspectionAtomSchema),
  referencesTruncated: z.boolean(),
  reverseReferencesTruncated: z.boolean(),
});
export const inspectionFlowSchema = z.object({
  version: z.literal(1),
  contextInformationId: z.string(),
  nodes: z.array(inspectionAtomSchema),
  edges: z.array(
    z.object({ from: z.string(), to: z.string(), relation: z.string() }),
  ),
  truncated: z.boolean(),
  externalReferences: z.number(),
});
export type InspectionModule = z.infer<typeof inspectionModuleSchema>;
export type InspectionAtom = z.infer<typeof inspectionAtomSchema>;
export type InspectionPage = z.infer<typeof inspectionPageSchema>;
export type InspectionDetail = z.infer<typeof inspectionDetailSchema>;
export type InspectionFlow = z.infer<typeof inspectionFlowSchema>;

const surfaceStatusCountSchema = z.object({
  status: z.string(),
  count: z.number().int().nonnegative(),
});
const surfaceListItemSchema = z.object({
  entityId: z.string(),
  entityKey: z.string(),
  title: z.string(),
  subtitle: z.string(),
  platform: z.string().optional(),
  status: z.string().optional(),
  occurredAt: z.string(),
  fields: inspectionPresentationSchema.shape.fields,
});
export const inspectionSurfacePageSchema = z.object({
  version: z.literal(1),
  surfaceId: z.string(),
  summary: z.object({
    windowStartedAt: z.string(),
    windowHours: z.number().int().positive(),
    counts: z.array(surfaceStatusCountSchema),
  }),
  items: z.array(surfaceListItemSchema),
  platforms: z.array(z.string()),
  statuses: z.array(z.string()),
  nextCursor: z.string().nullable(),
});
export const inspectionSurfaceEntitySchema = z.object({
  version: z.literal(1),
  surfaceId: z.string(),
  entity: surfaceListItemSchema,
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      presentation: z.enum([
        "field-grid",
        "relation-list",
        "timeline",
        "record-table",
        "relationship-graph",
      ]),
      items: z.array(
        z.object({
          id: z.string(),
          occurredAt: z.string(),
          status: z.string().optional(),
          fields: inspectionPresentationSchema.shape.fields,
          sourceInformationId: z.string().optional(),
        }),
      ),
    }),
  ),
});
export type InspectionSurfacePage = z.infer<typeof inspectionSurfacePageSchema>;
export type InspectionSurfaceEntity = z.infer<
  typeof inspectionSurfaceEntitySchema
>;

export const inspectionStorageSchema = z.object({
  version: z.literal(1),
  available: z.boolean(),
  title: z.string(),
  description: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      sourceInformationId: z.string().optional(),
      fields: inspectionPresentationSchema.shape.fields,
    }),
  ),
  nextCursor: z.string().nullable(),
});
