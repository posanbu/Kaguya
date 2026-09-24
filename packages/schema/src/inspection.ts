/**
 * 功能概述：定义开发者控制台的版本化只读 DTO，与内部 Ledger 和模块实例隔离。
 * 主要职责：各 inspection*Schema 校验 Module、Atom 摘要/详情、游标页和有界 Flow；
 * 对应类型供服务端投影与 WebUI 共享，领域视图/机制由 Manifest 声明；presentation 展示安全字段。
 * inspectionStorageSchema 区分真实存储不可用与空页，游标不包含内容。
 * record-browser 声明按事实时间浏览的记录、双向引用分组与受限来源投影；wiki-browser 以当前页面而非修订流水为主体。
 * presentation.fields 的可选 path 保留稳定字段身份，中文 label 仅用于展示；旧客户端和未声明状态的记录兼容。
 * model-request-browser 按模块与任务隔离每次请求，独立详情保留冻结输入、完整脱敏 Prompt 和投递证据；
 * storage-browser 将模块声明的持久库投影为紧凑表格，hiddenSections 允许领域页面收起无关的通用技术区。
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
    type: z.literal("wiki-browser"),
    area: z.string().trim().min(1),
    viewId: z.string().trim().min(1),
    pageKind: z.string().trim().min(1),
    empty: z.string().trim().min(1),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("storage-browser"),
    area: z.string().trim().min(1),
    columns: z.array(z.string().trim().min(1)).min(1).max(8),
    empty: z.string().trim().min(1),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("model-request-browser"),
    area: z.string().trim().min(1),
    viewId: z.string().trim().min(1),
    taskId: z.string().trim().min(1),
    mode: z.enum(["planner", "composer"]),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("record-browser"),
    area: z.string().trim().min(1),
    viewId: z.string().trim().min(1),
    recordKind: z.string().trim().min(1),
    presentation: z.literal("attention-gate").optional(),
    status: z
      .object({
        field: inspectionFieldPathSchema,
        options: z
          .array(
            z.object({
              value: z.string().trim().min(1).max(100),
              label: z.string().trim().min(1),
            }),
          )
          .min(1)
          .refine(
            (options) =>
              new Set(options.map(({ value }) => value)).size ===
              options.length,
            "Duplicate record status value",
          ),
      })
      .optional(),
    titleField: inspectionFieldPathSchema,
    searchFields: z.array(inspectionFieldPathSchema).min(1),
    fields: z.array(surfaceFieldSchema).min(1),
    labels: z.object({
      directory: z.string().min(1),
      search: z.string().min(1),
      placeholder: z.string().min(1),
      empty: z.string().min(1),
      mechanism: z.string().min(1),
    }),
    notice: z.string().optional(),
    relations: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        viewId: z.string().min(1),
        kinds: z.array(z.string().min(1)).min(1),
        reference: z.string().min(1),
        direction: z.enum(["forward", "reverse"]).optional(),
        presentation: z.enum(["field-grid", "ranked-list"]),
        fields: z.array(surfaceFieldSchema).min(1),
        rankField: inspectionFieldPathSchema.optional(),
        empty: z.string().min(1),
        limit: z.number().int().min(1).max(50),
        source: z
          .object({
            reference: z.string().min(1),
            viewId: z.string().min(1),
            kinds: z.array(z.string().min(1)).min(1),
            fields: z.array(surfaceFieldSchema).min(1),
          })
          .optional(),
      }),
    ),
  }),
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
  hiddenSections: z
    .array(
      z.enum([
        "responsibilities",
        "settings",
        "templates",
        "prompt-renderers",
        "diagnostics",
      ]),
    )
    .optional(),
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
  fields: z.array(
    z.object({
      path: inspectionFieldPathSchema.optional(),
      label: z.string(),
      value: jsonValueSchema,
    }),
  ),
});

const kind = z.object({
  kind: z.string(),
  displayName: z.string(),
  description: z.string(),
});
const capability = z.object({ id: z.string(), apiVersion: z.number() });
const moduleTag = z
  .string()
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/u);
export const inspectionModuleSchema = z.object({
  definitionId: z.string(),
  tags: z.array(moduleTag).default([]),
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
/** 记录目录不伪造人物平台列表或窗口统计，仍复用同一目录条目与游标协议。 */
export const inspectionRecordPageSchema = inspectionSurfacePageSchema.omit({
  summary: true,
  platforms: true,
  statuses: true,
});
const inspectionWikiPageSummarySchema = z.object({
  pageId: z.string().min(1),
  scopeInformationId: z.string().min(1),
  entityInformationId: z.string().min(1),
  title: z.string().min(1),
  pageType: z.enum(["scope", "entity"]),
  version: z.number().int().positive(),
  dirty: z.boolean(),
  reasons: z.array(z.string()),
  updatedAt: z.string(),
  sectionCount: z.number().int().nonnegative(),
  excerpt: z.string(),
});
export const inspectionWikiPageSchema = z.object({
  version: z.literal(1),
  surfaceId: z.string(),
  items: z.array(inspectionWikiPageSummarySchema),
  nextCursor: z.string().nullable(),
});
export const inspectionWikiPageDetailSchema = z.object({
  version: z.literal(1),
  surfaceId: z.string(),
  page: inspectionWikiPageSummarySchema,
  sections: z.array(
    z.object({
      heading: z.string(),
      content: z.string(),
      evidenceSourceInformationIds: z.array(z.string()),
      claimIds: z.array(z.string()),
    }),
  ),
  history: z.array(
    z.object({
      version: z.number().int().positive(),
      recordedAt: z.string(),
      sectionCount: z.number().int().nonnegative(),
    }),
  ),
  historyTruncated: z.boolean(),
});
export type InspectionWikiPage = z.infer<typeof inspectionWikiPageSchema>;
export type InspectionWikiPageDetail = z.infer<
  typeof inspectionWikiPageDetailSchema
>;
export const inspectionSurfaceEntitySchema = z.object({
  version: z.literal(1),
  surfaceId: z.string(),
  entity: surfaceListItemSchema,
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      presentation: z.enum([
        "ranked-list",
        "field-grid",
        "relation-list",
        "timeline",
        "record-table",
        "relationship-graph",
      ]),
      truncated: z.boolean().optional(),
      items: z.array(
        z.object({
          id: z.string(),
          occurredAt: z.string(),
          status: z.string().optional(),
          fields: inspectionPresentationSchema.shape.fields,
          sourceInformationId: z.string().optional(),
          rank: z.number().int().nonnegative().optional(),
          relatedSource: z
            .object({
              informationId: z.string().optional(),
              available: z.boolean(),
              fields: inspectionPresentationSchema.shape.fields,
            })
            .optional(),
        }),
      ),
    }),
  ),
});
export type InspectionSurfacePage = z.infer<typeof inspectionSurfacePageSchema>;
export type InspectionSurfaceEntity = z.infer<
  typeof inspectionSurfaceEntitySchema
>;

/** 一行对应一次持久化模型请求；status 描述模型调用，outcomeText 描述实际业务结果。 */
export const inspectionRequestSummarySchema = z.object({
  requestId: z.string(),
  occurredAt: z.string(),
  status: z.string(),
  triggerText: z.string(),
  outcomeText: z.string(),
  inputCount: z.number().int().nonnegative(),
  triggerKind: z.enum(["inbound", "authorization"]).optional(),
});
export const inspectionRequestPageSchema = z.object({
  version: z.literal(1),
  surfaceId: z.string(),
  items: z.array(inspectionRequestSummarySchema),
  nextCursor: z.string().nullable(),
});
export const inspectionRequestDetailSchema = z.object({
  version: z.literal(1),
  surfaceId: z.string(),
  request: inspectionRequestSummarySchema,
  inputs: z.array(
    z.object({
      informationId: z.string(),
      occurredAt: z.string().optional(),
      sender: z.string().optional(),
      text: z.string(),
    }),
  ),
  prompt: z
    .object({ available: z.boolean(), text: z.string().optional() })
    .refine(
      (prompt) => prompt.available === (prompt.text !== undefined),
      "Prompt availability must match its text",
    ),
  result: z.object({
    action: z.string().optional(),
    reason: z.string().optional(),
    text: z.string().optional(),
  }),
  model: inspectionPresentationSchema.shape.fields.optional(),
  trace: z.array(
    z.object({
      informationId: z.string(),
      kind: z.string(),
      occurredAt: z.string(),
      label: z.string(),
      status: z.string().optional(),
    }),
  ),
  truncated: z.boolean(),
  contextAvailable: z.boolean(),
});
export type InspectionRequestSummary = z.infer<
  typeof inspectionRequestSummarySchema
>;
export type InspectionRequestPage = z.infer<typeof inspectionRequestPageSchema>;
export type InspectionRequestDetail = z.infer<
  typeof inspectionRequestDetailSchema
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
