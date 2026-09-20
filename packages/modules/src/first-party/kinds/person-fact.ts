/**
 * 功能概述：person-fact 领域的 Information schema 与不可变定义，独立维护本领域引用和日志投影。
 * 主要职责：下列 schema 校验入账载荷，各 kind 声明因果关系、上下文和诊断元数据；无 I/O。
 * 代码库关系：information-kinds.ts 稳定重导出公共对象；跨领域只复用相邻文件定义，保持 Registry 对象身份。
 * 输入输出与副作用：候选输入在 debug 投影中展示脱敏限长预览；提取结果的 info 摘要不含正文，
 * 只有 sensitivity=content 的 debug detail 投影 fact。这里只格式化已登记领域载荷，不读取模型原始输出。
 */
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { contentPreview, nonBlankString } from "./shared.js";

export const personFactCandidateInformationPayloadSchema = z
  .object({
    personId: nonBlankString,
    name: nonBlankString,
    text: nonBlankString,
  })
  .strict();

export type PersonFactCandidateInformationPayload = z.infer<
  typeof personFactCandidateInformationPayloadSchema
>;

export const personFactCandidateInformationKind = defineInformationKind({
  kind: "core.person.fact.candidate",
  displayName: "人物事实候选",
  description:
    "待提取人物事实的文本及其来源，在提交提取任务前登记；人物事实模块将其渲染为模型输入并校验输出证据。",
  payloadSchema: personFactCandidateInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "person.fact.candidate",
      ...contentPreview(payload.text),
    }),
  },
});

export const personFactExtractedPayloadSchema = z
  .object({
    personId: nonBlankString,
    name: nonBlankString,
    fact: nonBlankString,
  })
  .strict();

export type PersonFactExtractedPayload = z.infer<
  typeof personFactExtractedPayloadSchema
>;

export const personFactExtractedInformationKind = defineInformationKind({
  kind: "core.person.fact.extracted",
  displayName: "人物事实提取结果",
  description:
    "人物提取模型的输出通过结构和证据校验后登记的事实；下游可沿来源引用核查，不将未验证的模型文本作为事实。",
  payloadSchema: personFactExtractedPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.model.task.completed"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "person.fact.extracted" }),
    detail: {
      sensitivity: "content",
      project: ({ payload }) => ({
        event: "person.fact.extracted",
        ...contentPreview(payload.fact),
      }),
    },
  },
});
