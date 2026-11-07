/**
 * 功能概述：隔离 Linux 桌面的 observe/act/verify 参数合同，不暴露 Cua 原始工具或命令。
 * 主要职责：观察明确区分桌面和窗口；一次输入绑定观察引用，文字插入与整字段替换分别声明。
 * insert/key 必须使用窗口观察，避免固定 Cua 驱动的桌面输入忽略位置并沿用隐式焦点。
 * 代码库关系：LinuxToolsHost 注册这些 schema，可信 GUI component 再检查实际 capture、许可和 generation。
 * 输入输出与副作用：仅校验参数；截图坐标保持原图像素，verify 只核对当前状态并引用原操作。
 */
import { z } from "@kaguya/schema";

const text = z.string().min(1).max(4096);
export const linuxGuiTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("desktop") }).strict(),
  z
    .object({
      kind: z.literal("window"),
      pid: z.number().int().positive(),
      windowId: z.number().int().positive(),
    })
    .strict(),
]);
export const linuxGuiObservationSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    environmentId: text,
    workflowId: text,
    generation: z.number().int().nonnegative(),
  })
  .strict();
export const linuxGuiObserveSchema = z
  .object({ target: linuxGuiTargetSchema })
  .strict();
const observed = { observation: linuxGuiObservationSchema };
const selector = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("element"),
      elementId: z.string().regex(/^e[0-9]{1,5}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pixel"),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
    })
    .strict(),
]);
const key = z
  .string()
  .regex(
    /^(?:[ -~]|enter|tab|escape|space|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2]))$/,
  );
export const linuxGuiActSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...observed,
      action: z.literal("click"),
      selector,
      button: z.enum(["left", "middle", "right"]).default("left"),
    })
    .strict(),
  z
    .object({
      ...observed,
      action: z
        .literal("insert")
        .describe(
          "Requires an observation of the target window; desktop observations cannot select an insertion point.",
        ),
      selector,
      text: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[\x09\x0a\x0d\x20-\x7e]+$/),
    })
    .strict(),
  z
    .object({
      ...observed,
      action: z.literal("replace"),
      elementId: z.string().regex(/^e[0-9]{1,5}$/),
      value: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      ...observed,
      action: z
        .literal("key")
        .describe(
          "Requires an observation of the target window; desktop observations do not identify keyboard focus.",
        ),
      key,
      modifiers: z
        .array(z.enum(["ctrl", "shift", "alt", "super"]))
        .max(4)
        .default([]),
    })
    .strict(),
  z
    .object({
      ...observed,
      action: z.literal("scroll"),
      selector,
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(1).max(10).default(3),
    })
    .strict(),
]);
export const linuxGuiVerifySchema = z
  .object({
    target: linuxGuiTargetSchema,
    original: z.object({ operationId: text, attemptId: text }).strict(),
    verificationKind: z.literal("current-gui-state"),
    contains: z.string().min(1).max(4096),
  })
  .strict();
