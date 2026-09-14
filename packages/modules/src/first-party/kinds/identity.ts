/**
 * 功能概述：identity 领域的 Information schema 与不可变定义，独立维护本领域引用和日志投影。
 * 主要职责：下列 schema 校验入账载荷，各 kind 声明因果关系、上下文和诊断元数据；无 I/O。
 * 代码库关系：information-kinds.ts 稳定重导出公共对象；跨领域只复用相邻文件定义，保持 Registry 对象身份。
 */
import { platformDestinationSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { nonBlankString } from "./shared.js";
import { inboundTextInformationKind } from "./message.js";

const identityTerminalSchema = z
  .object({
    status: z.enum([
      "complete",
      "unresolved",
      "ambiguous",
      "degraded",
      "failed",
    ]),
    scopeMode: z.enum(["canonical", "ephemeral"]),
    platform: nonBlankString,
    adapterId: nonBlankString,
    scopeInformationId: nonBlankString.optional(),
    accountInformationId: nonBlankString.optional(),
    personInformationId: nonBlankString.optional(),
  })
  .strict() as any;

export const chatScopeEntityInformationKind = defineInformationKind({
  kind: "agent.chat.scope.entity",
  displayName: "会话范围实体",
  description:
    "身份归一时建立的平台会话范围，区分规范范围和临时范围；回合隔离与记忆范围选择通过引用复用它。",
  payloadSchema: z
    .object({
      platform: nonBlankString,
      adapterId: nonBlankString,
      destination: platformDestinationSchema,
      scopeMode: z.enum(["canonical", "ephemeral"]),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
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
      event: "identity.scope.entity",
      platform: payload.platform,
      adapterId: payload.adapterId,
      scopeMode: payload.scopeMode,
    }),
  },
});

export const chatScopeBindingInformationKind = defineInformationKind({
  kind: "agent.chat.scope.binding",
  displayName: "会话范围绑定",
  description:
    "身份归一时将平台目标绑定到会话实体；后续消息据此解析相同范围并追溯绑定依据。",
  payloadSchema: z
    .object({
      platform: nonBlankString,
      adapterId: nonBlankString,
      destination: platformDestinationSchema,
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:binds": {
      required: true,
      multiple: false,
      targetKinds: [chatScopeEntityInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "identity.scope.binding",
      platform: payload.platform,
      adapterId: payload.adapterId,
    }),
  },
});

export const platformAccountEntityInformationKind = defineInformationKind({
  kind: "agent.platform.account.entity",
  displayName: "平台账号实体",
  description:
    "身份归一时为平台、适配器与账号建立实体；人物观察和绑定通过引用关联同一平台账号。",
  payloadSchema: z
    .object({
      platform: nonBlankString,
      adapterId: nonBlankString,
      accountId: nonBlankString,
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
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
      event: "identity.account.entity",
      platform: payload.platform,
      adapterId: payload.adapterId,
    }),
  },
});

export const platformAccountBindingInformationKind = defineInformationKind({
  kind: "agent.platform.account.binding",
  displayName: "账号人物绑定",
  description:
    "账号被关联到人物实体时记录绑定事实；后续人物解析据此复用人物身份并保留账号来源。",
  payloadSchema: z
    .object({ accountId: nonBlankString, personInformationId: nonBlankString })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:binds": {
      required: true,
      multiple: false,
      targetKinds: [platformAccountEntityInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: () => ({ event: "identity.account.binding" }),
  },
});

export const personEntityInformationKind = defineInformationKind({
  kind: "agent.person.entity",
  displayName: "人物实体",
  description:
    "身份归一需要建立人物身份时登记关联账号；人物解析和后续上下文以该实体引用表示人物。",
  payloadSchema: z.object({ accountId: nonBlankString }).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: () => ({ event: "identity.person.entity" }),
  },
});

export const personObservedInformationKind = defineInformationKind({
  kind: "agent.person.observed",
  displayName: "人物资料观察",
  description:
    "处理入站消息时记录账号昵称、群名片和观察时间；下游可追溯当时看到的资料，不将展示名称直接作为稳定身份。",
  payloadSchema: z
    .object({
      accountId: nonBlankString,
      nickname: nonBlankString.optional(),
      card: nonBlankString.optional(),
      observedAt: nonBlankString,
    })
    .strict() as any,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:observes": {
      required: true,
      multiple: false,
      targetKinds: [platformAccountEntityInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "identity.person.observed",
      hasNickname: payload.nickname !== undefined,
      hasCard: payload.card !== undefined,
    }),
  },
});

export const personResolutionInformationKind = defineInformationKind({
  kind: "agent.person.resolution",
  displayName: "人物身份解析结果",
  description:
    "人物解析完成时记录成功、未解析、歧义、降级或失败及实体引用；下游据此区分身份可用性与平台原始事实。",
  payloadSchema: identityTerminalSchema,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "identity.person.resolution",
        status: input.status,
        scopeMode: input.scopeMode,
        platform: input.platform,
        adapterId: input.adapterId,
      };
    },
  },
});

export const personContextCompletedInformationKind = defineInformationKind({
  kind: "agent.person.context.completed",
  displayName: "消息身份上下文就绪",
  description:
    "单条入站消息的身份处理结束后登记状态和实体引用；释放 Heartflow 身份屏障并触发独立原始记忆写回。",
  payloadSchema: identityTerminalSchema,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [inboundTextInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "identity.context.completed",
        status: input.status,
        scopeMode: input.scopeMode,
        platform: input.platform,
        adapterId: input.adapterId,
      };
    },
  },
});
