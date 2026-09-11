/**
 * 功能概述：定义开发者控制台的版本化只读 DTO，与内部 Ledger 和模块实例隔离。
 * 主要职责：各 inspection*Schema 校验 Module、Atom 摘要/详情、游标页和有界 Flow；
 * 对应类型供服务端投影与 WebUI 共享，Kind 名称和 Prompt renderer 元数据来自 Manifest。
 * 代码库关系：由 schema/index.ts 导出，server/inspection.ts 产出，Web API 校验后展示。
 * 输入输出与副作用：仅声明 JSON wire contract，无 I/O；详情 payload 必须由服务端先脱敏。
 */
import { z } from "zod";
import { jsonValueSchema } from "./information.js";

const kind = z.object({
  kind: z.string(),
  displayName: z.string(),
  description: z.string(),
});
const capability = z.object({ id: z.string(), apiVersion: z.number() });
export const inspectionModuleSchema = z.object({
  definitionId: z.string(),
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
