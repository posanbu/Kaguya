import {
  outboundMessageContentSchema,
  platformDestinationSchema,
  z,
} from "@kaguya/schema";
import { defineInformationKind, type InformationKindDefinition } from "@kaguya/sdk";

const nonBlankString = z.string().trim().min(1);

const messageSourceSchema = z
  .object({
    adapterId: nonBlankString,
    platform: nonBlankString,
    platformMessageId: nonBlankString,
    destination: platformDestinationSchema,
    senderId: nonBlankString,
  })
  .strict();

export const inboundTextInformationKind = defineInformationKind({
  kind: "core.message.inbound.text",
  payloadSchema: z
    .object({
      text: z.string(),
      source: messageSourceSchema,
    })
    .strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
});

export const filterDecisionInformationKind = defineInformationKind({
  kind: "core.filter.decision",
  payloadSchema: z
    .object({
      shouldReply: z.boolean(),
      reason: nonBlankString,
      targetInstanceId: nonBlankString.optional(),
    })
    .strict() as any,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.message.inbound.text"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
});

export const assistantTextInformationKind = defineInformationKind({
  kind: "core.message.assistant.text",
  payloadSchema: z
    .object({ text: z.string(), source: messageSourceSchema })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.llm.completed"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
});

export const deliveryRequestedInformationKind = defineInformationKind({
  kind: "core.delivery.requested",
  payloadSchema: z
    .object({
      adapterId: nonBlankString,
      platform: nonBlankString,
      destination: platformDestinationSchema,
      message: outboundMessageContentSchema,
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.message.assistant.text"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
});

export const informationModuleKinds = [
  inboundTextInformationKind,
  filterDecisionInformationKind,
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
] as const satisfies readonly InformationKindDefinition<string, any>[];
