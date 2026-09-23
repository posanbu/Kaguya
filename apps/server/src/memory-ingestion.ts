/**
 * 功能概述：主动记忆录入的有界 AI workflow；HTTP 接受、模型整理和数据库提交有独立状态。
 * 主要职责：MemoryIngestionService 轮询持久任务，冻结结构计划后执行受控仓储；pause/close
 * 取消模型并等待当前任务退出，适配 Profile 热切换和服务关闭。createMemoryIngestionGenerator
 * 使用当前 Profile 的 heavy 模型，通用规则与原文在 user 数据请求中发送，不修改系统配置。
 * 代码库关系：server.ts 注入动态就绪状态；管理路由复用服务端仓储与认证；数据库保留租约和幂等结果。
 * 输入输出与副作用：外部模型最大沿用 Profile 的 300 秒上限，租约 6 分钟；异常只保存安全错误码，
 * provider 原始报错及凭据不返回 WebUI。模型结果永远不能绕过仓储业务校验。
 */
import { memoryIngestionTemplateDeclaration } from "@kaguya/modules";
import { readPromptResources } from "@kaguya/modules/prompt-templates/node";
import { KaguyaLlmClient, KaguyaLlmError } from "@kaguya/llm";
import {
  MemoryIngestionError,
  type PostgresMemoryIngestionStore,
  type MemoryIngestionContext,
} from "@kaguya/database";
import { memoryIngestionPlanSchema, type CompiledPrompt } from "@kaguya/schema";
import type { RuntimeModelSelectionResolver } from "@kaguya/composition";

export function memoryIngestionPrompt(
  context: MemoryIngestionContext,
): CompiledPrompt {
  const rules = readPromptResources([memoryIngestionTemplateDeclaration])[0]!
    .content;
  const data = JSON.stringify({
    current: context.job,
    history: context.history.map((j) => ({
      text: j.text,
      sourceType: j.sourceType,
      resolutions: j.resolutions,
    })),
    candidates: context.candidates,
    existingClaims: context.claims,
  });
  return {
    kind: "memory",
    templateId: "kaguya.memory.ingestion.v1",
    text: `${rules}\n\nDATA (JSON):\n${data}`,
    templates: [{ name: "rules", content: rules }],
    variables: [{ name: "input_data", content: data, informationIds: [] }],
  };
}
export function createMemoryIngestionGenerator(
  resolveModel: RuntimeModelSelectionResolver,
) {
  return async (
    context: MemoryIngestionContext,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const selected = resolveModel({ modelTier: "heavy" });
    const client = new KaguyaLlmClient({
      model: selected.model,
      resolveGenerationOptions: () => selected.generationOptions ?? {},
    });
    return (
      await client.generate({
        modelId: selected.modelId,
        outputMode: "object",
        outputSchema: memoryIngestionPlanSchema,
        prompt: memoryIngestionPrompt(context),
        signal,
      })
    ).output;
  };
}
export interface MemoryIngestionDependencies {
  store: PostgresMemoryIngestionStore;
  generate: (
    context: MemoryIngestionContext,
    signal: AbortSignal,
  ) => Promise<unknown>;
}
export class MemoryIngestionService {
  private running: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private suspended = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly dependencies: () =>
      MemoryIngestionDependencies | undefined,
  ) {}
  available() {
    const dependencies = !this.suspended && this.dependencies();
    if (!dependencies)
      throw new MemoryIngestionError("ingestion_unavailable", 503);
    return dependencies.store;
  }
  start() {
    this.suspended = false;
    this.timer ??= setInterval(() => {
      void this.kick();
    }, 1000);
    this.timer.unref();
    void this.kick();
  }
  async pause() {
    this.suspended = true;
    this.controller?.abort();
    await this.running;
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pause();
  }
  kick(): Promise<void> {
    if (this.running) return this.running;
    if (this.suspended) return Promise.resolve();
    this.running = this.process()
      .catch(() => {
        // 数据库暂时不可用时保留持久状态，下次 tick/重启继续；不泄漏原始错误。
      })
      .finally(() => {
        this.running = undefined;
        this.controller = undefined;
      });
    return this.running;
  }
  private async process() {
    const dependencies = this.dependencies();
    if (!dependencies) return;
    const { store, generate } = dependencies;
    const claim = await store.claim();
    if (!claim) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      if (this.suspended) controller.abort();
      controller.signal.throwIfAborted();
      if (!claim.plan) {
        const output = await generate(
          await store.context(claim.job),
          controller.signal,
        );
        controller.signal.throwIfAborted();
        await store.savePlan(claim, output);
      }
      controller.signal.throwIfAborted();
      await store.apply(claim);
    } catch (error) {
      await store.fail(
        claim,
        controller.signal.aborted
          ? "processing_interrupted"
          : error instanceof MemoryIngestionError
            ? error.code
            : error instanceof KaguyaLlmError
              ? "model_" + error.kind
              : "processing_failed",
      );
    }
  }
}
