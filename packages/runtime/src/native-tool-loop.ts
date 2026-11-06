/**
 * 每步从独立媒体快照重新追加输入图像，文字历史裁剪先移除上一轮宿主媒体块，不消耗文字/工具预算。
 * 原点不含路由；首轮冻结模型绑定，重启后每步核验，关闭 native 或更改配置即停止原 run。
 * projectNativeToolResults 只读原图，关联图片和完整工具批次共同裁剪，闭合旧图片不永久占用预算。
 * 功能概述：协调 Heavy 单步模型与 W3 行动，不把 provider execute 装进 LLM SDK。
 * NativeToolLoop 固定宿主目录/预算，按持久步骤恢复调用和实际回执；校验拒绝也按实际投影执行输出预算。
 * cancel 先停 run 再调用 W3。
 * nativeToolWireName 生成稳定无点号别名，fitToolTranscript 校验调用与结果的角色、ID 和工具名，按完整交互裁剪，保留图像与开放配对。
 * Runtime 装配本类，Memory/W5/W7/W8 共用注册端口。授权、目标及环境绑定只来自宿主回调。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  actionBasisDigest,
  actionDigest,
  actionExecutionDigest,
  type KaguyaDatabase,
  type NativeToolRunRow,
  type NativeToolCallRow,
} from "@kaguya/database";
import type { InformationCore } from "@kaguya/engine";
import {
  nativeToolBudgetSchema,
  actionDecisionInformationKind,
  nativeToolStepSchema,
  type ActionAccess,
  type ActionIntent,
  type ActionEnvironment,
  type NativeToolBudget,
} from "@kaguya/sdk";
import {
  compiledPromptSchema,
  nativeMemorySnapshotSchema,
  nativeMessagesSchema,
  nativeToolDeclarationSchema,
  z,
  type CompiledPrompt,
  type NativeMessage,
  type NativeToolDeclaration,
  type JsonObject,
  type JsonValue,
} from "@kaguya/schema";
import type {
  ModelTaskCapability,
  ModelTaskClientOptions,
  ModelTaskRequest,
  ModelTaskResult,
} from "./model-task.js";

import {
  projectNativeToolResults,
  type NativeArtifactReader,
} from "./native-tool-results.js";
import { withoutFrozenMediaInput } from "./media-input.js";
import { nativeModelBindingSchema } from "./information-kinds.js";

export type NativeToolRegistration = {
  id: string;
  version: string;
  description: string;
  providerId: string;
  providerVersion: string;
  executor: string;
  readonly: boolean;
  independent: boolean;
  /** 宿主权限配置的修订，配置变化必须换版本。 */
  policyVersion: string;
  bind(input: {
    arguments: JsonObject;
    runInformationId: string;
    stepInformationId: string;
    scope: string;
  }): Promise<{ target: JsonObject; environment?: ActionEnvironment }>;
  authorize(input: {
    intent: ActionIntent;
    mode: "execute" | "read" | "cancel";
  }): Promise<boolean>;
} & (
  | { inputSchema: z.ZodType; jsonSchema?: never; validateInput?: never }
  | {
      inputSchema?: never;
      jsonSchema: Record<string, JsonValue>;
      validateInput(input: unknown): boolean | Promise<boolean>;
    }
);
export interface NativeToolTaskRoute {
  taskId: string;
  definitionId: string;
  routeId?: string;
  toolIds: readonly string[];
}
export interface NativeToolLoopOptions {
  registrations: readonly NativeToolRegistration[];
  tasks: readonly NativeToolTaskRoute[];
  budget?: Partial<NativeToolBudget>;
  memory?: boolean;
  readArtifact?: NativeArtifactReader;
  guiTasks?: import("./gui-tasks.js").GuiTaskHost;
}
type Spec = {
  guiEnvironment?: {
    environmentId: string;
    generation: number;
    workflowId: string;
  };
  origin: ReturnType<typeof nativeToolOrigin>;
  modelBinding: z.infer<typeof nativeModelBindingSchema>;
  actionRunInformationId: string;
  observationId: string;
  sceneId: string;
  scope: string;
  deadline: string;
  budget: NativeToolBudget;
  declarations: NativeToolDeclaration[];
  bindings: Record<string, string>;
  rootPrompt: CompiledPrompt;
  contextInformationIds: string[];
  memory: z.infer<typeof nativeMemorySnapshotSchema> | null;
};
export function nativeToolOrigin(request: ModelTaskRequest<unknown>) {
  return {
    instanceId: request.activation.instanceId,
    definitionId: request.activation.definitionId,
    taskId: request.task.taskId,
    sourceInformationId: request.sourceInformationId,
  };
}
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function toolSchema(tool: NativeToolRegistration) {
  return tool.jsonSchema ?? z.toJSONSchema(tool.inputSchema!, { io: "input" });
}
function toolBinding(tool: NativeToolRegistration) {
  return actionDigest({
    id: tool.id,
    version: tool.version,
    providerId: tool.providerId,
    providerVersion: tool.providerVersion,
    executor: tool.executor,
    policyVersion: tool.policyVersion,
    readonly: tool.readonly,
    independent: tool.independent,
    schema: toolSchema(tool),
  });
}
export function nativeToolWireName(id: string, version: string) {
  return `t_${createHash("sha256")
    .update(JSON.stringify([id, version]))
    .digest("base64url")}`;
}
export function fitToolTranscript(
  input: NativeMessage[],
  maxBytes: number,
): NativeMessage[] {
  return fitToolTranscriptWithMetadata(input, maxBytes).messages;
}
/** 字节数只计当前 prompt 追加前的原生消息数组 JSON UTF-8；每个省略段均为完整闭合段。 */
export function fitToolTranscriptWithMetadata(
  input: NativeMessage[],
  maxBytes: number,
) {
  const segments: { messages: NativeMessage[]; pinned: boolean }[] = [];
  let current: NativeMessage[] = [];
  const calls = new Map<string, string>(),
    seen = new Set<string>();
  let image = false;
  for (const message of input) {
    if (message.nativeToolResultGroup !== undefined) {
      const previous = segments.at(-1);
      const last = previous?.messages.at(-1);
      const ids = Array.isArray(last?.content)
        ? last.content.flatMap((p) =>
            p &&
            typeof p === "object" &&
            !Array.isArray(p) &&
            p.type === "tool-result"
              ? [p.toolCallId]
              : [],
          )
        : [];
      if (
        current.length ||
        message.role !== "user" ||
        last?.role !== "tool" ||
        !ids.length ||
        actionDigest(ids) !== actionDigest(message.nativeToolResultGroup)
      )
        throw new Error("native-orphan-image");
      previous!.messages.push(message);
      continue;
    }
    current.push(message);
    if (Array.isArray(message.content))
      for (const raw of message.content) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        if (["image", "file"].includes(String(raw.type))) image = true;
        if (raw.type === "tool-call") {
          if (
            message.role !== "assistant" ||
            typeof raw.toolCallId !== "string" ||
            !raw.toolCallId ||
            typeof raw.toolName !== "string" ||
            !raw.toolName
          )
            throw new Error("native-invalid-call");
          const id = raw.toolCallId;
          if (seen.has(id)) throw new Error("native-duplicate-call");
          calls.set(id, raw.toolName);
          seen.add(id);
        }
        if (raw.type === "tool-result") {
          if (
            message.role !== "tool" ||
            typeof raw.toolCallId !== "string" ||
            !calls.has(raw.toolCallId) ||
            calls.get(raw.toolCallId) !== raw.toolName
          )
            throw new Error("native-orphan-result");
          calls.delete(raw.toolCallId);
        }
      }
    if (!calls.size) {
      segments.push({ messages: current, pinned: image });
      current = [];
      image = false;
      seen.clear();
    }
  }
  if (current.length) segments.push({ messages: current, pinned: true });
  let used = Buffer.byteLength(
    JSON.stringify(segments.flatMap((s) => s.messages)),
  );
  const originalBytes = used;
  let omittedSegments = 0;
  while (used > maxBytes) {
    const index = segments.findIndex(
      (s, i) => !s.pinned && i < segments.length - 1,
    );
    if (index < 0) throw new Error("native-context-budget");
    segments.splice(index, 1);
    omittedSegments++;
    used = Buffer.byteLength(
      JSON.stringify(segments.flatMap((s) => s.messages)),
    );
  }
  return {
    messages: segments.flatMap((s) => s.messages),
    metadata: {
      measurement: "native-message-array-json-utf8" as const,
      truncated: omittedSegments > 0,
      omittedSegments,
      originalBytes,
      retainedBytes: used,
      budgetBytes: maxBytes,
    },
  };
}

export class NativeToolLoop {
  private readonly registrations = new Map<string, NativeToolRegistration>();
  private readonly inflight = new Map<
    string,
    Promise<ModelTaskResult<unknown>>
  >();
  constructor(
    private readonly deps: {
      db: KaguyaDatabase;
      core: InformationCore;
      actions: ActionAccess & { cancelForwarded?: ActionAccess["cancel"] };
      model: ModelTaskCapability;
      resolveModel: (
        request: ModelTaskRequest<unknown>,
      ) => ReturnType<ModelTaskClientOptions["resolveModel"]>;
      options: NativeToolLoopOptions;
    },
  ) {
    const wires = new Set<string>();
    for (const tool of deps.options.registrations) {
      const wire = nativeToolWireName(tool.id, tool.version);
      if (
        this.registrations.has(tool.id) ||
        wires.has(wire) ||
        (tool.independent && !tool.readonly)
      )
        throw new Error("native-tool-registration-invalid");
      nativeToolDeclarationSchema.parse({
        id: tool.id,
        version: tool.version,
        wireName: wire,
        description: tool.description,
        inputSchema: toolSchema(tool),
      });
      this.registrations.set(
        tool.id,
        Object.freeze(
          tool.jsonSchema
            ? { ...tool, jsonSchema: json(tool.jsonSchema) }
            : { ...tool },
        ),
      );
      wires.add(wire);
    }
    for (const task of deps.options.tasks)
      if (task.toolIds.some((id) => !this.registrations.has(id)))
        throw new Error("native-tool-route-invalid");
  }
  enabled(request: ModelTaskRequest<unknown>) {
    return this.deps.options.tasks.find(
      (t) =>
        t.taskId === request.task.taskId &&
        t.definitionId === request.activation.definitionId &&
        t.routeId === request.selectionPolicy.routeId,
    );
  }
  async existing(request: ModelTaskRequest<unknown>) {
    return this.deps.db.nativeTools.byOrigin(nativeToolOrigin(request));
  }
  private modelBinding(request: ModelTaskRequest<unknown>) {
    return nativeModelBindingSchema.parse({
      selectionPolicy: request.selectionPolicy,
      resolvedModel: this.deps.resolveModel(request),
    });
  }
  execute<T>(request: ModelTaskRequest<T>): Promise<ModelTaskResult<T>> {
    const key = actionDigest(nativeToolOrigin(request));
    const prior = this.inflight.get(key);
    if (prior) return prior as Promise<ModelTaskResult<T>>;
    const work = this.run(key, request).finally(() =>
      this.inflight.delete(key),
    );
    this.inflight.set(key, work);
    return work as Promise<ModelTaskResult<T>>;
  }
  private async open<T>(key: string, request: ModelTaskRequest<T>) {
    const saved = await this.existing(request);
    if (saved) return saved;
    const source = await this.deps.core.get(request.sourceInformationId);
    const turn = source?.payload.turn as
      { claimInformationId?: string } | undefined;
    if (!turn?.claimInformationId)
      throw new Error("native-tool-observation-required");
    const row = (
      await this.deps.db.sql.query<{
        observation_id: string;
        scene_id: string;
        contract: any;
        manifest: any;
      }>(
        `SELECT o.observation_id,p.scene_id,p.contract,o.manifest FROM information_observations o JOIN information_observation_progress p USING(stream_id)
      WHERE o.complete AND o.replacement_observation_id IS NULL AND o.manifest->>'runInformationId'=$1 AND p.consumer_id='agent.situation' AND ($2::text IS NULL OR o.observation_id=$2) ORDER BY o.through_position LIMIT 1`,
        [
          turn.claimInformationId,
          source?.kind === "agent.gui.task.requested.v1"
            ? source.payload.observationId
            : null,
        ],
      )
    ).rows[0];
    if (!row) throw new Error("native-tool-observation-required");
    const memory = nativeMemorySnapshotSchema.safeParse(
      row.manifest.content.memory,
    );
    const a = row.contract.address,
      d = a.destination;
    const budget = nativeToolBudgetSchema.parse(this.deps.options.budget ?? {});
    const route = this.enabled(request);
    if (!route) throw new Error("native-route-unavailable");
    const declarations = route.toolIds.map((id) => {
      const t = this.registrations.get(id)!;
      return nativeToolDeclarationSchema.parse({
        id: t.id,
        version: t.version,
        wireName: nativeToolWireName(t.id, t.version),
        description: t.description,
        inputSchema: toolSchema(t),
      });
    });
    const scope = JSON.stringify([
      a.platform,
      a.adapterId,
      d.kind,
      d.userId ?? d.groupId ?? d.conversationId ?? null,
    ]);
    const gui =
      source?.kind === "agent.gui.task.requested.v1"
        ? source.payload
        : undefined;
    if (
      request.task.taskId === "agent.gui.execute" &&
      (!gui || gui.scope !== scope || gui.observationId !== row.observation_id)
    )
      throw new Error("native-gui-source-invalid");
    const spec: Spec = {
      ...(gui
        ? {
            guiEnvironment: {
              environmentId: String(gui.environmentId),
              generation: Number(gui.generation),
              workflowId: String(gui.workflowId),
            },
          }
        : {}),
      origin: nativeToolOrigin(request),
      modelBinding: this.modelBinding(request),
      actionRunInformationId: turn.claimInformationId,
      observationId: row.observation_id,
      sceneId: row.scene_id,
      scope,
      deadline: new Date(Date.now() + budget.maxDurationMs).toISOString(),
      budget,
      declarations,
      bindings: Object.fromEntries(
        route.toolIds.map((id) => [
          id,
          toolBinding(this.registrations.get(id)!),
        ]),
      ),
      rootPrompt: request.prompt,
      contextInformationIds: request.contextAtoms.map((a) => a.informationId),
      memory: memory.success ? memory.data : null,
    };
    return this.deps.db.nativeTools.open(
      key,
      json(spec) as unknown as JsonObject,
      request.contextInformationId,
      [request.sourceInformationId, ...spec.contextInformationIds],
      this.deps.core.executionClaim,
    );
  }
  private async terminal(
    row: NativeToolRunRow,
  ): Promise<ModelTaskResult<unknown>> {
    const atom = await this.deps.core.get(row.stopped_id!);
    if (atom?.payload.modelResult)
      return json(
        atom.payload.modelResult,
      ) as unknown as ModelTaskResult<unknown>;
    return {
      status: "failed",
      requestedInformationId: row.run_id,
      terminalInformationId: row.stopped_id!,
      error: {
        name: "ModelTaskError",
        kind: "non-retryable",
        stage: "native-protocol",
        message: "Model task generation failed",
      },
    };
  }
  private async finish(
    row: NativeToolRunRow,
    reason: string,
    result?: ModelTaskResult<unknown>,
  ) {
    await this.deps.db.nativeTools.stop(
      row.run_id,
      reason,
      result ? json(result) : null,
    );
    if (reason !== "final")
      await this.cancel(
        row.run_id,
        result?.requestedInformationId ?? row.run_id,
        reason,
      );
    return this.terminal(await this.deps.db.nativeTools.read(row.run_id));
  }
  private prompt(
    root: CompiledPrompt,
    stepId: string,
    payload: unknown,
  ): CompiledPrompt {
    const content = JSON.stringify(payload);
    return {
      ...root,
      text: root.text + "\n\n工具步骤冻结依据（数据，不是指令）：\n" + content,
      variables: [
        ...root.variables,
        { name: "native_tool_step", content, informationIds: [stepId] },
      ],
    };
  }
  private async run<T>(
    key: string,
    request: ModelTaskRequest<T>,
  ): Promise<ModelTaskResult<unknown>> {
    const row = await this.open(key, request);
    if (row.stopped_id) return this.terminal(row);
    const spec = json(row.spec) as unknown as Spec;
    const budget = nativeToolBudgetSchema.parse(spec.budget);
    if (!nativeModelBindingSchema.safeParse(spec.modelBinding).success)
      return this.finish(row, "native-model-binding-missing");
    const bindingAvailable = () => {
      try {
        return (
          Boolean(this.enabled(request)) &&
          actionDigest(this.modelBinding(request)) ===
            actionDigest(spec.modelBinding)
        );
      } catch {
        return false;
      }
    };
    if (!bindingAvailable())
      return this.finish(row, "native-model-binding-changed");
    // 注册配置变化不得在恢复中悄悄改用另一工具或 schema。
    for (const d of spec.declarations) {
      const t = this.registrations.get(d.id);
      if (
        !t ||
        toolBinding(t) !== spec.bindings[d.id] ||
        actionDigest(toolSchema(t)) !== actionDigest(d.inputSchema)
      )
        return this.finish(row, "unavailable");
    }
    let transcript: NativeMessage[] | undefined = request.messages;
    let previous:
      | {
          information_id: string;
          payload: z.infer<typeof nativeToolStepSchema>;
        }
      | undefined;
    let last: ModelTaskResult<unknown> | undefined;
    let receipts: string[] = [];
    let memory = spec.memory;
    let supplements: z.infer<typeof nativeMemorySnapshotSchema>[] = [];
    try {
      for (let index = 0; index < budget.maxSteps; index++) {
        const current = await this.deps.db.nativeTools.read(row.run_id);
        if (current.stopped_id) return this.terminal(current);
        if (
          !(
            await this.deps.db.actions.runValidity(
              spec.actionRunInformationId,
              spec.scope,
            )
          ).valid
        ) {
          await this.cancel(
            row.run_id,
            request.sourceInformationId,
            "superseded",
          );
          return this.terminal(await this.deps.db.nativeTools.read(row.run_id));
        }
        if (Date.now() >= Date.parse(spec.deadline))
          return this.finish(row, "budget");
        if (!bindingAvailable())
          return this.finish(row, "native-model-binding-changed");
        if (
          spec.guiEnvironment &&
          !(await this.deps.options.guiTasks?.validate({
            ...spec.guiEnvironment,
            scope: spec.scope,
          }))
        )
          return this.finish(row, "unavailable");
        const step = await this.deps.db.nativeTools.freeze(
          {
            runInformationId: row.run_id,
            observationId: spec.observationId,
            stepIndex: index,
            previousStepInformationId: previous?.information_id ?? null,
            modelCompletedInformationId: last?.terminalInformationId ?? null,
            receiptIds: receipts,
            memory,
            supplements,
          },
          this.deps.core.executionClaim,
        );
        const prompt = this.prompt(
          compiledPromptSchema.parse(spec.rootPrompt),
          step.information_id,
          step.payload,
        );
        const contextIds = [
          ...new Set([
            ...spec.contextInformationIds,
            row.run_id,
            step.information_id,
            ...receipts,
            ...(last
              ? [last.requestedInformationId, last.terminalInformationId]
              : []),
          ]),
        ];
        const atoms = await this.deps.core.getMany(contextIds);
        const fitted = transcript
          ? fitToolTranscriptWithMetadata(
              withoutFrozenMediaInput(transcript),
              budget.maxContextBytes - Buffer.byteLength(prompt.text) - 4096,
            )
          : undefined;
        const requestInput: ModelTaskRequest<T> = {
          ...request,
          selectionPolicy: spec.modelBinding.selectionPolicy,
          nativeModelBinding: spec.modelBinding,
          prompt,
          contextAtoms: atoms,
          tools: spec.declarations,
          nativeStep: {
            runInformationId: row.run_id,
            stepIndex: index,
            deadline: spec.deadline,
            maxContextBytes: budget.maxContextBytes,
            maxOutputBytes: budget.maxOutputBytes,
          },
          ...(fitted
            ? {
                messages: fitted.messages,
                contextTrimming: fitted.metadata,
                nativeContinuation: false,
              }
            : { nativeContinuation: request.nativeContinuation ?? false }),
        };
        const generated = await this.deps.model.execute(requestInput);
        if (generated.status !== "tool-calls")
          return this.finish(
            row,
            generated.status === "completed"
              ? "final"
              : generated.status === "cancelled"
                ? "cancelled"
                : generated.status === "failed" &&
                    generated.error.reasonCode === "dispatched-without-terminal"
                  ? "model-outcome-unknown"
                  : "model-failed",
            generated,
          );
        const calls = await this.deps.db.nativeTools.registerCalls(
          row.run_id,
          index,
          generated.terminalInformationId,
          generated.calls,
          this.deps.core.executionClaim,
        );
        const requested = await this.deps.core.get(
          generated.requestedInformationId,
        );
        transcript = requested?.payload.messages
          ? nativeMessagesSchema.parse(requested.payload.messages)
          : [{ role: "user", content: prompt.text }];
        transcript.push(...generated.native.messages);
        let uncertain = false;
        // 默认按模型声明顺序。独立只读项使用有界分组，结果始终按原 call 序排列。
        for (let i = 0; i < calls.length;) {
          const parallel = (c: NativeToolCallRow) => {
            const d = spec.declarations.find(
                (d) => d.wireName === c.call.toolName,
              ),
              t = d && this.registrations.get(d.id);
            return t?.readonly && t.independent;
          };
          const group = [calls[i++]!];
          if (!uncertain && parallel(group[0]!))
            while (
              i < calls.length &&
              group.length < budget.parallelism &&
              parallel(calls[i]!)
            )
              group.push(calls[i++]!);
          const results = await Promise.all(
            group.map((c) =>
              this.call(row, spec, step.information_id, c, uncertain),
            ),
          );
          for (const result of results) if (result.uncertain) uncertain = true;
        }
        const saved = await this.deps.db.nativeTools.calls(row.run_id, index);
        const results = await this.deps.core.getMany(
          saved.map((c) => c.result_id!),
        );
        transcript.push(
          ...(await projectNativeToolResults(
            saved.map((c, i) => ({
              toolCallId: c.call_id,
              toolName: c.call.toolName,
              toolId:
                spec.declarations.find((d) => d.wireName === c.call.toolName)
                  ?.id ?? "",
              intentId: c.intent_id,
              scope: spec.scope,
              value: results[i]!.payload.value,
            })),
            this.deps.options.readArtifact,
            budget.maxContextBytes,
          )),
        );
        receipts = results.flatMap((a) =>
          a.payload.receiptId ? [String(a.payload.receiptId)] : [],
        );
        if (uncertain) return this.finish(row, "unknown");
        supplements = [];
        for (const [i, result] of results.entries()) {
          const declaration = spec.declarations.find(
            (d) => d.wireName === saved[i]!.call.toolName,
          );
          const registration =
            declaration && this.registrations.get(declaration.id);
          const value = result.payload.value as any;
          if (registration?.providerId === "core.native-memory") {
            if (value?.result?.memorySnapshot)
              supplements.push(
                nativeMemorySnapshotSchema.parse(value.result.memorySnapshot),
              );
            if (value?.result?.memorySnapshots)
              supplements.push(
                ...z
                  .array(nativeMemorySnapshotSchema)
                  .parse(value.result.memorySnapshots),
              );
          }
        }
        // 每个后继步骤冻结实际 Memory 工具返回的快照；发布工具返回其提交后同快照读取。
        const latest = supplements.at(-1);
        if (
          latest &&
          (!memory ||
            BigInt(latest.cutoff?.publicationPosition ?? "0") >=
              BigInt(memory.cutoff?.publicationPosition ?? "0"))
        )
          memory = latest;
        previous = step;
        last = generated;
      }
      return this.finish(row, "budget");
    } catch (error) {
      if (this.deps.core.executionSignal?.aborted) throw error;
      // 基础设施提交错误不能伪造失败事实；仅有界协议/预算拒绝在这里停止推进。
      const reason = error instanceof Error ? error.message : "";
      if (reason.startsWith("native-") || reason.startsWith("action-"))
        return this.finish(
          row,
          reason.includes("budget") || reason.includes("stopped")
            ? "budget"
            : "protocol",
        );
      throw error;
    }
  }
  private async grant(intent: ActionIntent, cause: string) {
    await this.deps.db.actions.authorize({
      id: intent.authorizationId,
      scope: intent.scope,
      version: intent.authorizationVersion,
      providerId: intent.providerId,
      executor: intent.executor,
      targetDigest: actionDigest(intent.target),
      argumentsDigest: actionDigest(intent.arguments),
      operationId: intent.operationId,
      basisDigest: actionBasisDigest(intent),
      executionDigest: actionExecutionDigest(intent),
      expiresAt: intent.deadline,
      causeInformationId: cause,
    });
  }
  private async call(
    row: NativeToolRunRow,
    spec: Spec,
    stepId: string,
    call: NativeToolCallRow,
    blocked: boolean,
  ) {
    if (call.result_id) {
      const r = await this.deps.core.get(call.result_id);
      const status = (r?.payload.value as any)?.status;
      const environment = (r?.payload.value as any)?.environmentValidation;
      return {
        uncertain:
          ["unknown", "partial", "output-budget"].includes(status) ||
          ["fenced", "unconfirmed"].includes(environment),
      };
    }
    const reject = async (reason: string) => {
      const id = await this.deps.db.nativeTools.result(
        call,
        { status: "rejected", evidence: "not-executed", reason },
        null,
      );
      const projected = await this.deps.core.get(id);
      return {
        uncertain:
          (projected?.payload.value as any)?.status === "output-budget",
      };
    };
    const declaration = spec.declarations.find(
      (t) => t.wireName === call.call.toolName,
    );
    const tool = declaration && this.registrations.get(declaration.id);
    if (!tool || !declaration) return reject("unknown-tool");
    if (call.call.validation !== "valid") return reject(call.call.validation);
    const input = call.call.input;
    const valid = tool.validateInput
      ? await tool.validateInput(input)
      : tool.inputSchema!.safeParse(input).success;
    if (!valid || !input || typeof input !== "object" || Array.isArray(input))
      return reject("invalid-input");
    if (blocked) return reject("prior-outcome-unconfirmed");
    let intentId = call.intent_id;
    if (!intentId) {
      const decision = await this.deps.core.registerOnce(
        "kaguya.native.tool.decision",
        `${row.run_id}:${call.step_index}:${call.call_index}`,
        actionDecisionInformationKind,
        {
          source: "runtime:native-tools",
          occurredAt: new Date().toISOString(),
          payload: {
            observationId: spec.observationId,
            domain: "tool" as const,
            reason: "native-call",
            policyVersion: "native-loop.v1",
          },
          references: [
            {
              relation: "core:uses-context",
              informationId: spec.actionRunInformationId,
            },
            { relation: "core:uses-context", informationId: call.completed_id },
          ],
        },
      );
      const dependencies = await this.deps.db.actions.dependenciesFor(
        spec.observationId,
        call.completed_id,
      );
      const args = input as JsonObject;
      const binding = await tool.bind({
        arguments: args,
        runInformationId: row.run_id,
        stepInformationId: stepId,
        scope: spec.scope,
      });
      if (
        spec.guiEnvironment &&
        (!binding.environment ||
          binding.environment.environmentId !==
            spec.guiEnvironment.environmentId ||
          binding.environment.generation !== spec.guiEnvironment.generation ||
          binding.environment.workflowId !== spec.guiEnvironment.workflowId)
      )
        throw new Error("native-gui-environment-changed");
      const operationId = `native:${row.run_id}:${call.step_index}:${call.call_index}:${actionDigest(call.call_id)}`;
      const intent: ActionIntent = {
        operationId,
        runInformationId: spec.actionRunInformationId,
        decisionInformationId: decision.informationId,
        scope: spec.scope,
        sceneId: spec.sceneId,
        authorizationId: `native-auth:${operationId}`,
        authorizationVersion: 1,
        domain: "tool",
        providerId: tool.providerId,
        providerVersion: tool.providerVersion,
        executor: tool.executor,
        toolName: tool.id,
        toolCallId: call.call_id,
        target: binding.target,
        arguments: args,
        dependencies,
        dependsOn: [],
        deadline: spec.deadline,
        ...(binding.environment ? { environment: binding.environment } : {}),
      };
      if (!(await tool.authorize({ intent, mode: "execute" })))
        return reject("authorization-denied");
      await this.grant(intent, call.completed_id);
      intentId = await this.deps.db.nativeTools.bind(
        call,
        intent,
        this.deps.core.executionClaim,
      );
    }
    let action = await this.deps.actions.read(intentId, spec.scope);
    if (!action.receiptId && action.state === "queued") {
      if (!(await tool.authorize({ intent: action.intent, mode: "execute" })))
        return reject("authorization-denied");
      action = await this.deps.actions.execute(intentId, spec.scope);
    }
    if (!action.receiptId) throw new Error("native-action-result-pending");
    if (!(await tool.authorize({ intent: action.intent, mode: "read" })))
      return reject("result-authorization-denied");
    const readAuthorizationId = `native-read:${row.run_id}:${call.step_index}:${call.call_index}:${randomUUID()}`;
    await this.deps.db.actions.authorize({
      id: readAuthorizationId,
      scope: spec.scope,
      version: 1,
      providerId: action.intent.providerId,
      executor: action.intent.executor,
      targetDigest: actionDigest(action.intent.target),
      argumentsDigest: actionDigest(action.intent.arguments),
      operationId: action.intent.operationId,
      basisDigest: actionBasisDigest(action.intent),
      executionDigest: actionExecutionDigest(action.intent),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      causeInformationId: call.completed_id,
    });
    const receipt = await this.deps.actions.readReceipt(
      action.receiptId,
      spec.scope,
      readAuthorizationId,
    );
    if (
      receipt.intentId !== intentId ||
      receipt.intent.toolCallId !== call.call_id
    )
      throw new Error("native-receipt-mismatch");
    const resultId = await this.deps.db.nativeTools.result(
      call,
      {
        ...receipt.outcome,
        receiptId: receipt.receiptId,
        resultHash: receipt.resultHash,
      },
      receipt.receiptId,
      readAuthorizationId,
    );
    const projected = await this.deps.core.get(resultId);
    return {
      uncertain:
        (projected?.payload.value as any)?.status === "output-budget" ||
        ["unknown", "partial"].includes(receipt.outcome.status) ||
        receipt.outcome.environmentValidation === "fenced" ||
        receipt.outcome.environmentValidation === "unconfirmed",
    };
  }
  async cancelRequest(request: {
    requestedInformationId: string;
    reason: string;
  }) {
    const atom = await this.deps.core.get(request.requestedInformationId);
    const runInformationId = (
      atom?.payload.nativeStep as { runInformationId?: string } | undefined
    )?.runInformationId;
    if (runInformationId)
      await this.cancel(runInformationId, request.requestedInformationId);
    return this.deps.model.cancel(request);
  }
  async cancel(
    runInformationId: string,
    causeId: string,
    reason = "cancelled",
    requireForwarded = false,
  ) {
    const row = await this.deps.db.nativeTools.read(runInformationId),
      spec = json(row.spec) as unknown as Spec;
    const stopped = await this.deps.db.nativeTools.stop(
      runInformationId,
      reason,
      null,
      causeId,
    );
    for (const id of await this.deps.db.nativeTools.requests(runInformationId))
      await this.deps.model.cancel({ requestedInformationId: id, reason });
    for (const id of await this.deps.db.nativeTools.intents(runInformationId)) {
      const view = await this.deps.actions.read(id, spec.scope);
      if (
        requireForwarded &&
        ["succeeded", "rejected", "cancelled", "superseded"].includes(
          view.state,
        )
      )
        continue;
      const tool = this.registrations.get(view.intent.toolName);
      if (
        !tool ||
        !(await tool.authorize({ intent: view.intent, mode: "cancel" }))
      ) {
        if (requireForwarded)
          throw new Error("native-cancel-forwarding-unavailable");
        continue;
      }
      const control = {
        ...view.intent,
        authorizationId: `native-cancel:${stopped}:${id}:${randomUUID()}`,
        authorizationVersion: 1,
        deadline: new Date(Date.now() + 60000).toISOString(),
      };
      // 控制授权绑定原执行 digest；只延长 grant 存活，不重写 intent deadline。
      await this.deps.db.actions.authorize({
        id: control.authorizationId,
        scope: spec.scope,
        version: 1,
        providerId: view.intent.providerId,
        executor: view.intent.executor,
        targetDigest: actionDigest(view.intent.target),
        argumentsDigest: actionDigest(view.intent.arguments),
        operationId: view.intent.operationId,
        basisDigest: actionBasisDigest(view.intent),
        executionDigest: actionExecutionDigest(view.intent),
        expiresAt: control.deadline,
        causeInformationId: causeId,
      });
      const cancel = requireForwarded
        ? this.deps.actions.cancelForwarded
        : this.deps.actions.cancel;
      if (!cancel) throw new Error("native-cancel-forwarding-unavailable");
      await cancel.call(this.deps.actions, {
        intentId: id,
        scope: spec.scope,
        causeInformationId: causeId,
        controlAuthorizationId: control.authorizationId,
      });
    }
  }
}
