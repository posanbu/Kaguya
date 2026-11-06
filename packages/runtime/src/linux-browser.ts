/**
 * 功能概述：定义可信 Linux Chromium 的原生 DOM 工具参数，不接受任意 JavaScript 或 CDP。
 * 代码库关系：LinuxToolsHost 使用这些 schema 注册 observe/act/verify；helper 保有观察记录，
 * 并核对当前页面、scope、lease 与 generation。模型提交的观察字段本身不构成授权。
 * 输入输出与副作用：仅进行有界参数校验；verify 明确引用原 operation/attempt，可核对控件实时选中状态，不重新点击。
 */
import { z } from "@kaguya/schema";

const text = z.string().min(1).max(4096);
export const linuxBrowserObservationSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    environmentId: text,
    workflowId: text,
    generation: z.number().int().nonnegative(),
  })
  .strict();

export const linuxBrowserObserveSchema = z
  .object({ screenshot: z.boolean().optional() })
  .strict();

const observed = { observation: linuxBrowserObservationSchema };
const nodeId = z.string().regex(/^n[0-9]{1,4}$/);
export const linuxBrowserActSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...observed,
      action: z.literal("navigate"),
      url: z.url().max(4096),
    })
    .strict(),
  z.object({ ...observed, action: z.literal("click"), nodeId }).strict(),
  z
    .object({
      ...observed,
      action: z.literal("fill"),
      nodeId,
      value: z.string().max(32768),
    })
    .strict(),
  z
    .object({
      ...observed,
      action: z.literal("select"),
      nodeId,
      value: z.string().max(4096),
    })
    .strict(),
]);

export const linuxBrowserVerifySchema = z.discriminatedUnion("mode", [
  z
    .object({
      ...observed,
      mode: z.literal("page"),
      original: z.object({ operationId: text, attemptId: text }).strict(),
      expectation: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("url"), equals: text }).strict(),
        z
          .object({
            kind: z.literal("text"),
            nodeId,
            equals: z.string().max(32768),
          })
          .strict(),
        z
          .object({
            kind: z.literal("value"),
            nodeId,
            equals: z.string().max(32768),
          })
          .strict(),
        z
          .object({
            kind: z.literal("checked"),
            nodeId,
            equals: z.boolean(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      ...observed,
      mode: z.literal("download"),
      verificationKind: z.literal("current-file-state"),
      original: z.object({ operationId: text, attemptId: text }).strict(),
      downloadId: z.string().uuid(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      offset: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().min(1).max(16777216).optional(),
    })
    .strict(),
]);
