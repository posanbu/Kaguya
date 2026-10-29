/** 独立 Qwen TTS 输出插件。插件只消费已授权正文，失败时登记终态并恰好派生一次文字回退。 */
import { createHash } from "node:crypto";
import { z } from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  defineModuleCapability,
  defineModulePlugin,
  defineVersionedInformationKind,
  mediaResourceStoreCapability,
  onInformation,
} from "@kaguya/sdk";
import { QwenTtsError, QwenTtsProvider } from "./provider.mjs";

const owner = "kaguya.qwen-tts";
const destinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("private"), userId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("group"), groupId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("web"),
    conversationId: z.string().optional(),
  }),
]);
export const ttsRequested = defineVersionedInformationKind({
  owner,
  version: 1,
  kind: "agent.tts.requested.v1",
  displayName: "TTS 合成请求",
  description: "已授权正文及冻结的 Qwen 合成参数。",
  payloadSchema: z.strictObject({
    text: z.string().min(1),
    model: z.string().min(1),
    voiceId: z.string().min(1),
    language: z.string().min(1),
    format: z.literal("wav"),
    endpoint: z.url(),
    timeoutMs: z.number().int().positive(),
    maxAudioBytes: z.number().int().positive(),
    destination: destinationSchema,
  }),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
    "agent:turn-claim": {
      required: false,
      multiple: false,
      targetKinds: ["agent.router.turn.claimed"],
    },
    "agent:turn-candidate": {
      required: false,
      multiple: false,
      targetKinds: ["agent.heartbeat.candidate"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "tts.requested" }),
  },
});
export const ttsCompleted = defineVersionedInformationKind({
  owner,
  version: 1,
  kind: "agent.tts.completed.v1",
  displayName: "TTS 合成完成",
  description: "持久音频资源已经完成校验并可供 Runtime 读取。",
  payloadSchema: z.strictObject({
    resourceId: z.string(),
    mimeType: z.string(),
    byteLength: z.number().int().positive(),
    sha256: z.string(),
    text: z.string(),
    elapsedMs: z.number().int().nonnegative(),
    providerRequestId: z.string().optional(),
    usage: z
      .strictObject({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
        characters: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [ttsRequested.kind],
    },
    "core:context": { required: true, multiple: false },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "tts.completed",
      byteLength: payload.byteLength,
      elapsedMs: payload.elapsedMs,
      ...(payload.usage ? { usage: payload.usage } : {}),
    }),
  },
});
export const ttsStarted = defineVersionedInformationKind({
  owner,
  version: 1,
  kind: "agent.tts.started.v1",
  displayName: "TTS 合成执行",
  description: "已开始外部调用；恢复时结果可能尚未登记。",
  payloadSchema: z.strictObject({ startedAt: z.iso.datetime() }),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
    "core:uses-context": {
      required: true,
      multiple: false,
      targetKinds: [ttsRequested.kind],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "tts.started" }),
  },
});
export const ttsFailed = defineVersionedInformationKind({
  owner,
  version: 1,
  kind: "agent.tts.failed.v1",
  displayName: "TTS 合成失败",
  description: "不含凭据和响应正文的结构化失败终态。",
  payloadSchema: z.strictObject({
    code: z.string(),
    elapsedMs: z.number().int().nonnegative(),
    fallback: z.literal("text"),
  }),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [ttsRequested.kind],
    },
    "core:context": { required: true, multiple: false },
  },
  log: {
    enabled: true,
    level: "warn",
    project: ({ payload }) => ({
      event: "tts.failed",
      code: payload.code,
      elapsedMs: payload.elapsedMs,
      fallback: payload.fallback,
    }),
  },
});
export const ttsCancelled = defineVersionedInformationKind({
  owner,
  version: 1,
  kind: "agent.tts.cancelled.v1",
  displayName: "TTS 合成取消",
  description: "所属回合已经结束；迟到产物不会派生语音或文字投递。",
  payloadSchema: z.strictObject({
    reason: z.literal("turn-no-longer-active"),
    elapsedMs: z.number().int().nonnegative(),
  }),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [ttsRequested.kind],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "tts.cancelled",
      reason: payload.reason,
      elapsedMs: payload.elapsedMs,
    }),
  },
});
export const ttsFallback = defineVersionedInformationKind({
  owner,
  version: 1,
  kind: "agent.tts.fallback.v1",
  displayName: "TTS 文字回退",
  description: "合成失败或完成产物缺失时唯一的文字降级决策。",
  payloadSchema: z.strictObject({
    reason: z.enum(["synthesis-failed", "resource-missing"]),
  }),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
    "core:uses-context": {
      required: true,
      multiple: false,
      targetKinds: [ttsCompleted.kind, ttsFailed.kind],
    },
  },
  log: {
    enabled: true,
    level: "warn",
    project: ({ payload }) => ({
      event: "tts.fallback",
      reason: payload.reason,
    }),
  },
});
const closedTurnKinds = [
  "agent.router.turn.completed",
  "agent.router.turn.failed",
  "agent.router.turn.silent",
  "agent.router.turn.superseded",
  "agent.router.turn.waiting",
  "agent.router.turn.interrupted",
];
export const outputCapability = defineModuleCapability(
  "agent:message-output-processor",
  1,
);

const stateSelector = defineInformationSelector({
  selectorId: "agent.tts.state",
  async select({ sourceAtom, ledger }) {
    const claim = sourceAtom.payload.turn?.claimInformationId;
    const turn = claim
      ? await ledger.find({
          kinds: closedTurnKinds,
          payloadContains: { claimInformationId: claim },
          limit: 20,
        })
      : [];
    const requests = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:caused-by",
      direction: "incoming",
      limit: 10,
    });
    const request = requests.find((item) => item.kind === ttsRequested.kind);
    if (!request)
      return [...requests, ...turn].map((item) => item.informationId);
    const terminal = await ledger.related({
      from: [request.informationId],
      relation: "core:status-of",
      direction: "incoming",
      limit: 6,
    });
    return [
      ...new Set(
        [...requests, ...terminal, ...turn].map((item) => item.informationId),
      ),
    ];
  },
});

const settingsSchema = z.strictObject({
  mode: z.enum(["text", "voice-fallback-text"]).default("text").meta({
    public: true,
    title: "输出模式",
    description: "文字，或语音失败时回退文字。",
    default: "text",
  }),
  scopeAllowlist: z.array(z.string().min(1)).default([]).meta({
    public: true,
    title: "语音会话",
    description: "允许语音的 QQ 会话范围；空列表保持文字。",
    default: [],
  }),
  apiKey: z.string().min(1).default("disabled").meta({
    public: true,
    secret: true,
    title: "DashScope API Key",
    description: "只保存在模块配置中，读取接口不会回显。",
  }),
  endpoint: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, "Endpoint must be HTTPS and contain no credentials, query or fragment")
    .default("https://dashscope-intl.aliyuncs.com")
    .meta({
      public: true,
      title: "API Endpoint",
      description: "与音色创建使用相同区域的 DashScope HTTPS 基地址。",
      default: "https://dashscope-intl.aliyuncs.com",
    }),
  model: z.string().min(1).default("qwen3-tts-vc-2026-01-22").meta({
    public: true,
    title: "合成模型",
    description: "必须与音色创建时的 target_model 匹配。",
    default: "qwen3-tts-vc-2026-01-22",
  }),
  voiceId: z.string().min(1).default("configure-a-voice-id").meta({
    public: true,
    title: "音色 ID",
    description: "同一账号、区域和模型下创建或已有的音色。",
    default: "configure-a-voice-id",
  }),
  language: z.string().min(1).default("Chinese").meta({
    public: true,
    title: "语言",
    description: "传给 Qwen 的 language_type。",
    default: "Chinese",
  }),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000).meta({
    public: true,
    title: "超时时间",
    description: "合成和下载的单阶段上限，单位毫秒。",
    default: 30000,
  }),
  maxTextLength: z.number().int().min(1).max(600).default(500).meta({
    public: true,
    title: "朗读长度上限",
    description: "超过后直接使用文字。",
    default: 500,
  }),
  maxAudioBytes: z
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(8 * 1024 * 1024)
    .meta({
      public: true,
      title: "音频大小上限",
      description: "下载音频的最大字节数。",
      default: 8 * 1024 * 1024,
    }),
});

export default function createPlugin(host) {
  const authorized = host.kind("core.message.assistant.authorized");
  const delivery = host.kind("core.delivery.requested");
  return defineModulePlugin({
    id: owner,
    version: "1.0.0",
    modules: [
      defineInformationModule({
        manifest: {
          protocolVersion: 1,
          definitionId: "plugin.qwen-tts",
          moduleVersion: "1.0.0",
          displayName: "Qwen TTS",
          summary: "将已授权的 QQ 短文本合成为语音，失败时回退文字。",
          description:
            "Qwen provider、持久事件和媒体资源均封装在独立插件内；平台发送仍由 Runtime 完成。",
          tags: ["output", "tts"],
          settingsSchema,
          consumes: [
            authorized,
            ttsRequested,
            ttsStarted,
            ttsCompleted,
            ttsFailed,
            ttsCancelled,
            ttsFallback,
            delivery,
            ...closedTurnKinds.map((kind) => host.kind(kind)),
          ],
          produces: [
            ttsRequested,
            ttsStarted,
            ttsCompleted,
            ttsFailed,
            ttsCancelled,
            ttsFallback,
            delivery,
          ],
          selectors: [stateSelector],
          promptRenderers: [],
          requires: [mediaResourceStoreCapability],
          provides: [outputCapability],
          inspection: {
            mechanism: [
              "只处理已授权正文，默认文字、按会话启用语音。",
              "已有终态复用产物或回退；Runtime 负责最终发送授权。",
            ],
            views: [
              {
                id: "requests",
                title: "合成请求",
                description: "正文与冻结模型、音色、区域。",
                kinds: [ttsRequested.kind],
                fields: [
                  { path: "model", label: "模型" },
                  { path: "voiceId", label: "音色" },
                  { path: "language", label: "语言" },
                ],
              },
              {
                id: "execution",
                title: "合成执行",
                description: "外部调用已开始，未登记结果时不能推断成功。",
                kinds: [ttsStarted.kind],
                fields: [{ path: "startedAt", label: "开始时间" }],
              },
              {
                id: "completed",
                title: "音频产物",
                description: "校验后的持久媒体引用。",
                kinds: [ttsCompleted.kind],
                fields: [
                  { path: "resourceId", label: "资源" },
                  { path: "byteLength", label: "字节数" },
                  { path: "elapsedMs", label: "耗时（毫秒）" },
                ],
              },
              {
                id: "failed",
                title: "合成失败",
                description: "结构化失败与文字回退。",
                kinds: [ttsFailed.kind],
                fields: [
                  { path: "code", label: "错误码" },
                  { path: "fallback", label: "回退" },
                ],
              },
              {
                id: "cancelled",
                title: "合成取消",
                description: "回合结束后不再发送迟到结果。",
                kinds: [ttsCancelled.kind],
                fields: [
                  { path: "reason", label: "原因" },
                  { path: "elapsedMs", label: "耗时（毫秒）" },
                ],
              },
              {
                id: "fallback",
                title: "文字回退",
                description: "输出降级的显式原因。",
                kinds: [ttsFallback.kind],
                fields: [{ path: "reason", label: "原因" }],
              },
            ],
          },
        },
        create: ({ settings }) => ({
          provisions: [
            {
              capability: outputCapability,
              value: Object.freeze({ ready: true }),
            },
          ],
          subscriptions: [
            onInformation(
              authorized,
              { subscriptionId: "qwen-tts.output", delivery: "durable" },
              async (source, context) => {
                const state = await context.select(stateSelector);
                let requested = state.find(
                  (item) => item.kind === ttsRequested.kind,
                );
                if (
                  state.some(
                    (item) =>
                      item.kind === delivery.kind ||
                      item.kind === ttsCancelled.kind,
                  )
                )
                  return;
                if (await cancelClosedTurn(state, requested, context, 0))
                  return;
                const targetKey = scopeKey(source.payload.source);
                if (
                  !requested &&
                  (settings.mode === "text" ||
                    source.payload.source.platform !== "qq" ||
                    !settings.scopeAllowlist.some(
                      (entry) => entry === "*" || entry === targetKey,
                    ) ||
                    !speakable(source.payload.text, settings.maxTextLength))
                ) {
                  await textDelivery(delivery, source, source, context);
                  return;
                }
                requested ??= await context.registerOnce(
                  "qwen-tts.requested.v1",
                  source.informationId,
                  ttsRequested,
                  {
                    payload: {
                      text: source.payload.text,
                      model: settings.model,
                      voiceId: settings.voiceId,
                      language: settings.language,
                      format: "wav",
                      endpoint: settings.endpoint,
                      timeoutMs: settings.timeoutMs,
                      maxAudioBytes: settings.maxAudioBytes,
                      destination: source.payload.source.destination,
                    },
                    references: deliveryReferences(source),
                  },
                );
                const completed = state.find(
                  (item) => item.kind === ttsCompleted.kind,
                );
                if (completed) {
                  const resource = await context
                    .use(mediaResourceStoreCapability)
                    .get(completed.payload.resourceId)
                    .catch(() => undefined);
                  if (
                    resource?.sha256 === completed.payload.sha256 &&
                    resource.bytes.byteLength ===
                      completed.payload.byteLength &&
                    resource.mimeType === completed.payload.mimeType
                  )
                    await audioDelivery(delivery, source, completed, context);
                  else await textDelivery(delivery, source, completed, context);
                  return;
                }
                const failed = state.find(
                  (item) => item.kind === ttsFailed.kind,
                );
                if (failed) {
                  await textDelivery(delivery, source, failed, context);
                  return;
                }
                const started = Date.now();
                context.signal.throwIfAborted();
                await context.registerOnce(
                  "qwen-tts.started.v1",
                  requested.informationId,
                  ttsStarted,
                  {
                    payload: { startedAt: new Date(started).toISOString() },
                    references: [
                      {
                        relation: "core:uses-context",
                        informationId: requested.informationId,
                      },
                    ],
                  },
                );
                let result;
                try {
                  const provider = new QwenTtsProvider({
                    apiKey: settings.apiKey,
                    endpoint: requested.payload.endpoint,
                    timeoutMs: requested.payload.timeoutMs,
                    maxAudioBytes: requested.payload.maxAudioBytes,
                  });
                  const audio = await provider.synthesize(
                    {
                      ...requested.payload,
                    },
                    context.signal,
                  );
                  if (context.signal.aborted) throw context.signal.reason;
                  if (
                    await cancelClosedTurn(
                      await context.select(stateSelector),
                      requested,
                      context,
                      Date.now() - started,
                    )
                  )
                    return;
                  const sha256 = createHash("sha256")
                    .update(audio.bytes)
                    .digest("hex");
                  const resourceId = `sha256:${sha256}`;
                  await context
                    .use(mediaResourceStoreCapability)
                    .put({
                      resourceId,
                      bytes: audio.bytes,
                      mimeType: audio.mimeType,
                      sha256,
                    })
                    .catch(() => {
                      throw new QwenTtsError(
                        "resource-store-failed",
                        "Audio resource could not be persisted",
                      );
                    });
                  context.signal.throwIfAborted();
                  result = await context.commitTerminal(
                    "agent.tts.result.v1",
                    requested.informationId,
                    ttsCompleted,
                    {
                      payload: {
                        resourceId,
                        mimeType: audio.mimeType,
                        byteLength: audio.bytes.byteLength,
                        sha256,
                        text: requested.payload.text,
                        elapsedMs: Date.now() - started,
                        ...(audio.requestId
                          ? { providerRequestId: audio.requestId }
                          : {}),
                        ...(audio.usage ? { usage: audio.usage } : {}),
                      },
                      references: [
                        {
                          relation: "core:status-of",
                          informationId: requested.informationId,
                        },
                      ],
                    },
                  );
                } catch (error) {
                  if (context.signal.aborted) throw error;
                  // 账本失败应交给持久订阅重试，不能改写为 provider 失败。
                  if (!(error instanceof QwenTtsError)) throw error;
                  result = await context.commitTerminal(
                    "agent.tts.result.v1",
                    requested.informationId,
                    ttsFailed,
                    {
                      payload: {
                        code: safeErrorCode(error),
                        elapsedMs: Date.now() - started,
                        fallback: "text",
                      },
                      references: [
                        {
                          relation: "core:status-of",
                          informationId: requested.informationId,
                        },
                      ],
                    },
                  );
                }
                context.signal.throwIfAborted();
                if (result.kind === ttsCompleted.kind)
                  await audioDelivery(delivery, source, result, context);
                else if (result.kind === ttsFailed.kind)
                  await textDelivery(delivery, source, result, context);
              },
            ),
          ],
        }),
      }),
    ],
  });
}

async function cancelClosedTurn(state, request, context, elapsedMs) {
  if (!state.some((item) => closedTurnKinds.includes(item.kind))) return false;
  if (request)
    await context.commitTerminal(
      "agent.tts.result.v1",
      request.informationId,
      ttsCancelled,
      {
        payload: { reason: "turn-no-longer-active", elapsedMs },
        references: [
          { relation: "core:status-of", informationId: request.informationId },
        ],
      },
    );
  return true;
}

async function audioDelivery(kind, source, completed, context) {
  context.signal.throwIfAborted();
  const p = completed.payload;
  await context.registerOnce(
    "qwen-tts.delivery.v1",
    source.informationId,
    kind,
    {
      causedByInformationId: assistantSourceId(source),
      payload: deliveryPayload(source, {
        kind: "audio",
        resourceId: p.resourceId,
        mimeType: p.mimeType,
        byteLength: p.byteLength,
        sha256: p.sha256,
        text: p.text,
      }),
      references: deliveryReferences(source, completed),
    },
  );
}
async function textDelivery(kind, source, cause, context) {
  context.signal.throwIfAborted();
  let result;
  if (cause.kind !== source.kind)
    result = await context.registerOnce(
      "qwen-tts.fallback.v1",
      source.informationId,
      ttsFallback,
      {
        payload: {
          reason:
            cause.kind === ttsCompleted.kind
              ? "resource-missing"
              : "synthesis-failed",
        },
        references: [
          { relation: "core:uses-context", informationId: cause.informationId },
        ],
      },
    );
  await context.registerOnce(
    "qwen-tts.delivery.v1",
    source.informationId,
    kind,
    {
      causedByInformationId: assistantSourceId(source),
      payload: deliveryPayload(source, {
        kind: "text",
        text: source.payload.text,
        ...(source.payload.expression
          ? { expression: source.payload.expression }
          : {}),
      }),
      references: deliveryReferences(source, result),
    },
  );
}
function deliveryPayload(source, message) {
  return {
    adapterId: source.payload.source.adapterId,
    platform: source.payload.source.platform,
    destination: source.payload.source.destination,
    message,
    turn: source.payload.turn,
    ...(source.payload.speech ? { speech: source.payload.speech } : {}),
  };
}
function deliveryReferences(source, result) {
  return [
    ...(result
      ? [{ relation: "core:result", informationId: result.informationId }]
      : []),
    ...(source.payload.turn == null
      ? []
      : [
          {
            relation: "agent:turn-claim",
            informationId: source.payload.turn.claimInformationId,
          },
          {
            relation: "agent:turn-candidate",
            informationId: source.payload.turn.candidateInformationId,
          },
        ]),
  ];
}
function assistantSourceId(source) {
  const assistantInformationId = source.references?.find(
    (reference) => reference.relation === "core:caused-by",
  )?.informationId;
  if (!assistantInformationId)
    throw new Error("Authorized output is missing its assistant source");
  return assistantInformationId;
}
function scopeKey(source) {
  const d = source.destination;
  return `${source.platform}:${source.adapterId}:${d.kind}:${d.userId ?? d.groupId ?? d.conversationId ?? "anonymous"}`;
}
function speakable(text, max) {
  return text.length <= max && !/```|\|\s*[-:]+\s*\||https?:\/\//u.test(text);
}
function safeErrorCode(error) {
  return error instanceof QwenTtsError ? error.code : "synthesis-failed";
}
