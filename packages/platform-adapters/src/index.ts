export type {
  PlatformDeliveryReceipt,
  PlatformInboundMessage,
  PlatformMessageSender,
  PlatformMessageTarget,
  PlatformName,
  PlatformReplySender,
} from "./types.js";
export {
  buildOneBotSendAction,
  normalizeOneBotMessageEvent,
  type NormalizeOneBotOptions,
  type OneBotActionRequest,
  type OneBotMessageSegment,
} from "./onebot.js";
export {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type JsonMessageTransport,
  type NapCatActionClientOptions,
  type NapCatOneBotAdapterOptions,
} from "./napcat.js";
