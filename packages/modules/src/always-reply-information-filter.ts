import { z } from "@kaguya/schema";
import {
  defineInformationModule,
  onInformation,
} from "@kaguya/sdk";

import {
  filterDecisionInformationKind,
  inboundTextInformationKind,
} from "./information-kinds.js";

export const alwaysReplyInformationFilterSettingsSchema = z
  .object({ replyTargetInstanceId: z.string().trim().min(1) })
  .strict();

export const alwaysReplyInformationFilterModule = defineInformationModule({
  manifest: {
    apiVersion: 1,
    definitionId: "demo.filter.always-information",
    displayName: "Always reply information filter",
    settingsSchema: alwaysReplyInformationFilterSettingsSchema,
    informationKinds: [inboundTextInformationKind, filterDecisionInformationKind],
  },
  create: ({ settings }) => ({
    subscriptions: [
      onInformation(inboundTextInformationKind, async (atom, context) => {
        await context.append(filterDecisionInformationKind, {
          payload: {
            shouldReply: true,
            reason: "always-reply",
            targetInstanceId: settings.replyTargetInstanceId,
          },
        });
        void atom;
      }),
    ],
  }),
});
