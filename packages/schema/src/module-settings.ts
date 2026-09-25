/**
 * 功能概述：模块全局配置的安全管理 DTO，与 Inspection 运行时详情分离。
 * 主要职责：声明可展示字段、实例版本、完整替换输入及字段错误；不承载隐藏 settings。
 * 代码库关系：Server 从模块 Zod 元数据投影，Web 通用表单校验响应。
 * 输入输出与副作用：纯 schema；revision 为不透明并发令牌，保存仅要求显式应用。
 */
import { z } from "zod";
export const moduleSettingsFieldSchema = z.strictObject({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.enum(["string", "number", "integer", "boolean", "array"]),
  itemType: z.enum(["string", "object"]).optional(),
  readOnly: z.boolean(),
  secret: z.boolean().optional(),
  required: z.boolean(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  enum: z.array(z.string()).optional(),
  default: z.unknown().optional(),
});
export const moduleSettingsInstanceSchema = z.strictObject({
  instanceId: z.string(),
  enabled: z.boolean(),
  revision: z.string(),
  settings: z.record(z.string(), z.unknown()),
});
export const moduleSettingsViewSchema = z.strictObject({
  definitionId: z.string(),
  scope: z.literal("global"),
  effect: z.enum(["explicit_apply", "immediate"]),
  fields: z.array(moduleSettingsFieldSchema),
  instances: z.array(moduleSettingsInstanceSchema),
});
export const moduleSettingsReplacementSchema = z.strictObject({
  revision: z.string().min(1),
  enabled: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
});
export type ModuleSettingsField = z.infer<typeof moduleSettingsFieldSchema>;
export type ModuleSettingsView = z.infer<typeof moduleSettingsViewSchema>;
export type ModuleSettingsInstance = z.infer<
  typeof moduleSettingsInstanceSchema
>;
export type ModuleSettingsReplacement = z.infer<
  typeof moduleSettingsReplacementSchema
>;
