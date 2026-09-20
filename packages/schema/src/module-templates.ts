/**
 * 功能概述：模块模板管理的安全 wire 契约，仅包含模板源码和静态声明。
 * 主要职责：验证来源、允许变量、partial 与组成关系，以及组级并发替换输入。
 * 代码库关系：Server 管理路由与 Web 编辑区共用，独立于运行时 CompiledPrompt。
 * 输入输出与副作用：无渲染、用户消息或 Memory；保存结果明确要求重启。
 */
import { z } from "zod";
export const moduleTemplateViewSchema = z.strictObject({
  templateId: z.string(),
  mutability: z.enum(["editable", "readonly"]),
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  allowedVariables: z.array(z.string()),
  allowedPartials: z.array(z.string()),
  composes: z.array(z.string()),
  content: z.string(),
  defaultContent: z.string(),
  source: z.enum(["default", "local"]),
});
export const moduleTemplatesViewSchema = z.strictObject({
  definitionId: z.string(),
  revision: z.string(),
  effect: z.literal("restart_required"),
  templates: z.array(moduleTemplateViewSchema),
});
export const moduleTemplateReplacementSchema = z.strictObject({
  revision: z.string().min(1),
  content: z.string().max(131072),
});
export const moduleTemplateRestoreSchema = z.strictObject({
  revision: z.string().min(1),
});
export type ModuleTemplatesView = z.infer<typeof moduleTemplatesViewSchema>;
