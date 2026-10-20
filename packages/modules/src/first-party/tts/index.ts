/**
 * 功能概述：持久化 TTS 请求 → 合成结果 → 唯一平台投递请求。
 * 主要职责：调用前登记执行标记，恢复复用产物，未知结果保守回退，迟到结果不发送。
 * 代码库关系：Heavy 统一出口产生请求，宿主能力合成/存储，Runtime 执行授权与平台发送。
 * 输入输出与副作用：durable handlers 写信息原子；不直接调用平台 transport。
 */
import { randomUUID } from "node:crypto";
import { z } from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  onInformation,
} from "@kaguya/sdk";
import { deliveryRequestedInformationKind } from "../kinds/message.js";
import { ttsCapability } from "./capability.js";
import {
  ttsRequested,
  ttsStarted,
  ttsResult,
  ttsDeliveryCancelled,
} from "./facts.js";

const resultSelector = defineInformationSelector({
  selectorId: "kaguya.tts.result",
  async select({ ledger, sourceAtom }) {
    return (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 2,
      })
    )
      .filter((a) => a.kind === ttsResult.kind)
      .map((a) => a.informationId);
  },
});
export function createTtsModule() {
  return defineInformationModule({
    manifest: {
      definitionId: "agent.tts",
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      displayName: "语音合成",
      summary: "按会话策略持久化合成语音，失败只回退一次原正文。",
      description:
        "复用持久化产物并登记唯一合成终态，平台投递由 Runtime 负责。",
      inspection: {
        mechanism: [
          "授权后的当前会话短正文按显式配置选择语音。",
          "登记执行阶段，恢复复用产物；未知执行结果只回退文字。",
          "过期或回合已结束时取消投递；平台回执不代表用户已经播放。",
        ],
        views: [
          {
            id: "tts-lifecycle",
            title: "语音任务",
            description: "等待、执行、结果与取消；投递回执沿信息引用查看。",
            kinds: [
              ttsRequested.kind,
              ttsStarted.kind,
              ttsResult.kind,
              ttsDeliveryCancelled.kind,
            ],
            fields: [
              { path: "taskKey", label: "任务摘要" },
              { path: "identity", label: "合成参数" },
              { path: "request.taskKey", label: "结果任务摘要" },
              { path: "outcome.status", label: "结果" },
              { path: "outcome.reason", label: "失败或取消原因" },
              { path: "outcome.audio", label: "音频资源" },
              { path: "elapsedMs", label: "处理耗时（毫秒）" },
              { path: "inputCharacters", label: "输入字符数（非计费用量）" },
              {
                path: "providerCharacters",
                label: "供应商返回字符用量（空表示未知）",
              },
            ],
          },
        ],
      },
      settingsSchema: z.object({}).strict(),
      consumes: [ttsRequested, ttsResult],
      produces: [
        ttsStarted,
        ttsResult,
        ttsDeliveryCancelled,
        deliveryRequestedInformationKind,
      ],
      selectors: [resultSelector],
      promptRenderers: [],
      requires: [ttsCapability],
      provides: [],
    },
    create: () => ({
      provisions: [],
      subscriptions: [
        onInformation(
          ttsRequested,
          { subscriptionId: "kaguya.tts.synthesize", delivery: "durable" },
          async (atom, context) => {
            if ((await context.select(resultSelector)).length) return;
            const host = context.use(ttsCapability);
            const request = atom.payload;
            const startedAt = performance.now();
            let providerCharacters: number | null = null;
            const current = async () =>
              !context.signal.aborted &&
              Date.parse(request.expiresAt) > context.now().getTime() &&
              (await host.isCurrent(request));
            const cancelled = {
              status: "cancelled",
              reason: "expired_or_cancelled",
            } as const;
            let outcome: z.infer<typeof ttsResult.payloadSchema>["outcome"] =
              cancelled;
            try {
              if (await current()) {
                let audio = await host.find(request.taskKey);
                if (audio) outcome = { status: "completed", audio };
                else {
                  const attempt = randomUUID();
                  const marker = await context.registerOnce(
                    "kaguya.tts.attempt.v1",
                    atom.informationId,
                    ttsStarted,
                    { payload: { attempt } },
                  );
                  if (marker.payload.attempt !== attempt) {
                    // 远端可能已经计费；找不到登记产物时不再次合成。
                    audio = await host.find(request.taskKey);
                    outcome = audio
                      ? { status: "completed", audio }
                      : { status: "failed", reason: "outcome_unknown" };
                  } else {
                    let stage: "synthesis_failed" | "storage_failed" =
                      "synthesis_failed";
                    try {
                      const signal = AbortSignal.any([
                        context.signal,
                        AbortSignal.timeout(
                          Math.max(
                            1,
                            Date.parse(request.expiresAt) -
                              context.now().getTime(),
                          ),
                        ),
                      ]);
                      const generated = await abortable(
                        host.synthesize(request, signal),
                        signal,
                      );
                      providerCharacters = generated.providerCharacters ?? null;
                      if (!signal.aborted && (await current())) {
                        if (generated.synthesizedText !== request.text)
                          throw new Error("TTS text mismatch");
                        stage = "storage_failed";
                        audio = await host.save(request.taskKey, generated);
                        outcome = { status: "completed", audio };
                      }
                    } catch {
                      outcome = { status: "failed", reason: stage };
                    }
                  }
                }
              }
            } catch {
              outcome = { status: "failed", reason: "storage_failed" };
            }
            if (!(await current())) outcome = cancelled;
            await context.commitTerminal(
              "kaguya.tts.result.v1",
              atom.informationId,
              ttsResult,
              {
                payload: {
                  request,
                  outcome,
                  elapsedMs: Math.max(0, performance.now() - startedAt),
                  inputCharacters: Array.from(request.text).length,
                  providerCharacters,
                },
                references: [
                  {
                    relation: "core:status-of",
                    informationId: atom.informationId,
                  },
                  {
                    relation: "agent:tts-source",
                    informationId: request.assistantInformationId,
                  },
                ],
              },
            );
          },
        ),
        onInformation(
          ttsResult,
          { subscriptionId: "kaguya.tts.release", delivery: "durable" },
          async (atom, context) => {
            const { request, outcome } = atom.payload;
            const host = context.use(ttsCapability);
            const cancelDelivery = () =>
              context.registerOnce(
                "kaguya.tts.delivery.v1",
                request.assistantInformationId,
                ttsDeliveryCancelled,
                {
                  payload: { request },
                  references: request.turn
                    ? [
                        {
                          relation: "agent:turn-claim",
                          informationId: request.turn.claimInformationId,
                        },
                        {
                          relation: "agent:turn-candidate",
                          informationId: request.turn.candidateInformationId,
                        },
                      ]
                    : [],
                },
              );
            if (
              outcome.status === "cancelled" ||
              context.signal.aborted ||
              Date.parse(request.expiresAt) <= context.now().getTime() ||
              !(await host.isCurrent(request))
            ) {
              if (!context.signal.aborted) await cancelDelivery();
              return;
            }
            const audio =
              outcome.status === "completed" &&
              (await host.exists(outcome.audio).catch(() => false))
                ? outcome.audio
                : undefined;
            if (
              context.signal.aborted ||
              Date.parse(request.expiresAt) <= context.now().getTime() ||
              !(await host.isCurrent(request))
            ) {
              if (!context.signal.aborted) await cancelDelivery();
              return;
            }
            await context.registerOnce(
              "kaguya.tts.delivery.v1",
              request.assistantInformationId,
              deliveryRequestedInformationKind,
              {
                payload: {
                  ...request.target,
                  turn: request.turn,
                  ...(!audio
                    ? {
                        ttsFallbackReason:
                          outcome.status === "failed"
                            ? outcome.reason
                            : ("resource_missing" as const),
                      }
                    : {}),
                  message: audio
                    ? {
                        kind: "audio",
                        text: request.text,
                        audio,
                        expiresAt: request.expiresAt,
                      }
                    : { kind: "text", text: request.text },
                },
                references: [
                  {
                    relation: "agent:tts-source",
                    informationId: request.assistantInformationId,
                  },
                  ...(request.turn
                    ? [
                        {
                          relation: "agent:turn-claim",
                          informationId: request.turn.claimInformationId,
                        },
                        {
                          relation: "agent:turn-candidate",
                          informationId: request.turn.candidateInformationId,
                        },
                      ]
                    : []),
                ],
              },
            );
          },
        ),
      ],
    }),
  });
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error("TTS execution cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
