import { z } from "@kaguya/schema";
import { defineModule, onEvent } from "@kaguya/sdk";

import { messageIngestedEvent, replyRequestedEvent } from "./events.js";

export const alwaysReplyFilterSettingsSchema = z
  .object({ replyTargetInstanceId: z.string().trim().min(1) })
  .strict();

export const alwaysReplyFilterModule = defineModule({
  manifest: {
    apiVersion: 1,
    definitionId: "demo.filter.always",
    displayName: "Always reply filter",
    settingsSchema: alwaysReplyFilterSettingsSchema,
  },
  create: ({ settings }) => ({
    subscriptions: [
      onEvent(messageIngestedEvent, async (event, context) => {
        await context.emit(replyRequestedEvent, {
          targetInstanceId: settings.replyTargetInstanceId,
          messageId: event.payload.message.messageId,
        });
      }),
    ],
  }),
});
