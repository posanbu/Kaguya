/**
 * 功能概述：管理 API 的独立 agent.gui.execute 入口，复用现有 reliable runner 与 NativeToolLoop。
 * submit 以环境和客户端 UUID 去重，并由宿主选择有效观察、模型路由与环境代际；read 查询同一来源。
 * cancel 与 NativeToolStore 的 open/admission 共锁，覆盖未创建 run 的取消，随后转发既有取消协议。
 * pending/forwarded 取消事实独立于任务终态；同一可靠队列重试转发，任务停止不吞掉控制请求。
 * durable handler 重启后读取同一来源及 run；HTTP 连接不拥有执行生命周期，不创建第二套调度器。
 * 配置/环境变化停止任务，普通模块不能通过本类选择路由；输出只返回公开身份和实际终态。
 */
import type { KaguyaDatabase } from "@kaguya/database";
import type { InformationCore } from "@kaguya/engine";
import { z, type InformationAtom, type DeepReadonly } from "@kaguya/schema";
import { nativeToolOriginCancelledInformationKind } from "@kaguya/sdk";
import { guiTaskRequestedKind, guiTaskTerminalKind } from "./gui-task-kinds.js";
import { runtimeContextInformationKind } from "./information-kinds.js";
import { nativeToolOrigin, type NativeToolLoop } from "./native-tool-loop.js";
import type { ModelTaskRequest } from "./model-task.js";

export interface GuiTaskHost {
  bindings: readonly {
    environmentId: string;
    scope: string;
    workflowId: string;
    routeId: string;
    revision: string;
  }[];
  inspect(
    environmentId: string,
  ): Promise<{ state: string; generation: number }>;
  validate(input: {
    environmentId: string;
    scope: string;
    workflowId: string;
    generation: number;
  }): Promise<boolean>;
}
export const guiTaskInputSchema = z
  .object({
    taskRequestId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(16000),
  })
  .strict();
type Requested = DeepReadonly<
  InformationAtom<
    typeof guiTaskRequestedKind.kind,
    z.infer<typeof guiTaskRequestedKind.payloadSchema>
  >
>;
const namespace = "kaguya.gui.task";
export class GuiTaskService {
  constructor(
    private readonly deps: {
      db: KaguyaDatabase;
      core: InformationCore;
      loop: NativeToolLoop;
      host?: GuiTaskHost | undefined;
      activations: readonly {
        instanceId: string;
        definitionId: string;
        enabled?: boolean;
      }[];
    },
  ) {
    deps.core.onDurable(namespace, guiTaskRequestedKind, (atom) =>
      this.execute(atom),
    );
    deps.core.onDurable(
      namespace + ".cancel",
      nativeToolOriginCancelledInformationKind,
      async (atom) => {
        const id = atom.references.find(
          (r) => r.relation === "core:uses-context",
        )?.informationId;
        const source = id ? await deps.core.get(id) : undefined;
        if (source?.kind === guiTaskRequestedKind.kind)
          await this.forwardCancellation(source as Requested);
      },
      { retryForever: true, retryDelayMs: 1000 },
    );
  }
  private async slot(type: string, key: string, group = namespace) {
    const id = (
      await this.deps.db.sql.query<{ information_id: string }>(
        "SELECT information_id FROM information_commit_slots WHERE slot_type=$1 AND namespace=$2 AND key=$3",
        [type, group, key],
      )
    ).rows[0]?.information_id;
    return id ? this.deps.core.get(id) : undefined;
  }
  private async source(environmentId: string, taskRequestId: string) {
    return (await this.slot(
      "operation",
      JSON.stringify([environmentId, taskRequestId]),
    )) as Requested | undefined;
  }
  async submit(environmentId: string, raw: unknown) {
    const input = guiTaskInputSchema.parse(raw);
    const key = JSON.stringify([environmentId, input.taskRequestId]);
    const existing = await this.source(environmentId, input.taskRequestId);
    if (existing) {
      if (existing.payload.prompt !== input.prompt)
        throw new Error("gui-task-id-conflict");
      return this.read(environmentId, input.taskRequestId);
    }
    const host = this.deps.host;
    const binding = host?.bindings.find(
      (b) => b.environmentId === environmentId,
    );
    const activation = this.deps.activations.find(
      (a) => a.definitionId === "agent.heavy" && a.enabled !== false,
    );
    if (!binding || !host || !activation)
      throw new Error("gui-task-unavailable");
    const environment = await host.inspect(environmentId);
    if (
      environment.state !== "ready" ||
      !(await host.validate({ ...binding, generation: environment.generation }))
    )
      throw new Error("gui-environment-unavailable");
    const row = (
      await this.deps.db.sql.query<{ observation_id: string; manifest: any }>(
        `
      SELECT o.observation_id,o.manifest FROM information_observations o
      JOIN information_observation_progress p USING(stream_id)
      LEFT JOIN information_action_runs r ON r.run_id=o.manifest->>'runInformationId'
      WHERE o.complete AND o.replacement_observation_id IS NULL AND p.consumer_id='agent.situation'
      AND r.invalidated_id IS NULL AND (r.scope IS NULL OR r.scope=$1)
      AND jsonb_build_array(p.contract->'address'->>'platform', p.contract->'address'->>'adapterId',
        p.contract->'address'->'destination'->>'kind', COALESCE(p.contract->'address'->'destination'->>'userId',
        p.contract->'address'->'destination'->>'groupId',p.contract->'address'->'destination'->>'conversationId'))=$1::jsonb
      ORDER BY o.through_position DESC LIMIT 1`,
        [binding.scope],
      )
    ).rows[0];
    if (!row) throw new Error("gui-observation-required");
    const context = await this.deps.core.registerOnce(
      namespace + ".context",
      key,
      runtimeContextInformationKind,
      {
        payload: {},
        source: "runtime:gui-tasks",
        occurredAt: new Date().toISOString(),
        references: [],
      },
    );
    const source = await this.deps.core.registerOnce(
      namespace,
      key,
      guiTaskRequestedKind,
      {
        payload: {
          ...input,
          environmentId: binding.environmentId,
          scope: binding.scope,
          workflowId: binding.workflowId,
          revision: binding.revision,
          generation: environment.generation,
          observationId: row.observation_id,
          turn: { claimInformationId: row.manifest.runInformationId },
          activation: {
            instanceId: activation.instanceId,
            definitionId: "agent.heavy" as const,
          },
          selectionPolicy: { tier: "heavy" as const, routeId: binding.routeId },
        },
        source: "runtime:gui-tasks",
        occurredAt: new Date().toISOString(),
        references: [
          { relation: "core:context", informationId: context.informationId },
          {
            relation: "core:uses-context",
            informationId: row.manifest.frozenInformationId,
          },
          {
            relation: "core:uses-context",
            informationId: row.manifest.runInformationId,
          },
        ],
      },
    );
    if (source.payload.prompt !== input.prompt)
      throw new Error("gui-task-id-conflict");
    return this.read(environmentId, input.taskRequestId);
  }
  private async request(source: Requested): Promise<ModelTaskRequest<string>> {
    const p = source.payload;
    return {
      task: {
        taskId: "agent.gui.execute",
        outputMode: "text",
        outputSchema: z.string(),
        allowedTiers: ["heavy"],
      },
      activation: { ...p.activation },
      selectionPolicy: { ...p.selectionPolicy },
      sourceInformationId: source.informationId,
      contextInformationId: source.references.find(
        (r) => r.relation === "core:context",
      )!.informationId,
      contextAtoms: [
        source,
        ...(await this.deps.core.getMany(
          source.references
            .filter((r) => r.relation === "core:uses-context")
            .map((r) => r.informationId),
        )),
      ],
      prompt: {
        kind: "message",
        text: p.prompt,
        templateId: "agent.gui.execute.v1",
        templates: [{ name: "main", content: p.prompt }],
        variables: [],
      },
    };
  }
  private async terminal(
    source: Requested,
    status: "completed" | "failed" | "stopped",
    reason: string,
    output: string | null = null,
  ) {
    const request = await this.request(source);
    const run = await this.deps.db.nativeTools.byOrigin(
      nativeToolOrigin(request),
    );
    return this.deps.core.commitTerminal(
      namespace,
      source.informationId,
      guiTaskTerminalKind,
      {
        payload: {
          status,
          reason,
          runInformationId: run?.run_id ?? null,
          output,
        },
        source: "runtime:gui-tasks",
        occurredAt: new Date().toISOString(),
        references: [
          {
            relation: "core:context",
            informationId: request.contextInformationId,
          },
          { relation: "core:caused-by", informationId: source.informationId },
          { relation: "core:status-of", informationId: source.informationId },
        ],
      },
    );
  }
  private async forwardCancellation(source: Requested) {
    const request = await this.request(source),
      origin = nativeToolOrigin(request);
    const pending = await this.deps.db.nativeTools.cancellation(origin);
    if (pending?.state !== "pending") return;
    const run = await this.deps.db.nativeTools.byOrigin(origin);
    if (run)
      await this.deps.loop.cancel(
        run.run_id,
        pending.requestedInformationId,
        "cancelled",
        true,
      );
    await this.deps.db.nativeTools.cancellationForwarded(
      origin,
      request.contextInformationId,
      this.deps.core.executionClaim,
    );
  }
  private async execute(source: Requested) {
    if (
      (
        await this.source(
          source.payload.environmentId,
          source.payload.taskRequestId,
        )
      )?.informationId !== source.informationId
    )
      throw new Error("gui-task-origin-unapproved");
    await this.forwardCancellation(source);
    if (await this.slot("terminal", source.informationId)) return;
    const request = await this.request(source);
    const p = source.payload,
      host = this.deps.host;
    const binding = host?.bindings.find(
      (b) =>
        b.environmentId === p.environmentId &&
        b.scope === p.scope &&
        b.workflowId === p.workflowId &&
        b.routeId === p.selectionPolicy.routeId &&
        b.revision === p.revision,
    );
    const previous = await this.deps.db.nativeTools.byOrigin(
      nativeToolOrigin(request),
    );
    if (!previous?.stopped_id && (!binding || !(await host?.validate(p)))) {
      const run = await this.deps.db.nativeTools.cancelOrigin(
        nativeToolOrigin(request),
        request.contextInformationId,
      );
      if (run) await this.forwardCancellation(source);
      await this.terminal(source, "stopped", "environment-unavailable");
      return;
    }
    try {
      const result = await this.deps.loop.execute(request);
      const run = await this.deps.db.nativeTools.byOrigin(
        nativeToolOrigin(request),
      );
      const stopped = run?.stopped_id
        ? await this.deps.core.get(run.stopped_id)
        : undefined;
      const reason = String(stopped?.payload.reason ?? result.status);
      await this.terminal(
        source,
        result.status === "completed"
          ? "completed"
          : reason === "cancelled"
            ? "stopped"
            : "failed",
        reason,
        result.status === "completed" ? result.output : null,
      );
    } catch (error) {
      this.deps.core.executionSignal?.throwIfAborted();
      if (error instanceof Error && error.message === "native-run-stopped") {
        await this.terminal(source, "stopped", "cancelled");
        return;
      }
      throw error;
    }
  }
  async read(environmentId: string, taskRequestId: string) {
    const source = await this.source(environmentId, taskRequestId);
    if (!source) throw new Error("gui-task-not-found");
    const request = await this.request(source);
    const terminal = await this.slot("terminal", source.informationId);
    const run = await this.deps.db.nativeTools.byOrigin(
      nativeToolOrigin(request),
    );
    const nativeTerminal = run?.stopped_id
      ? await this.deps.core.get(run.stopped_id)
      : undefined;
    const exhausted = await this.slot(
      "terminal",
      source.informationId,
      "execution." + namespace,
    );
    const nativeResult = nativeTerminal?.payload.modelResult as
      { status?: string; output?: unknown } | undefined;
    const reason = nativeTerminal?.payload.reason;
    const result =
      terminal?.payload ??
      (nativeTerminal
        ? {
            status:
              reason === "final" && nativeResult?.status === "completed"
                ? "completed"
                : reason === "cancelled"
                  ? "stopped"
                  : "failed",
            reason,
            runInformationId: run!.run_id,
            output:
              typeof nativeResult?.output === "string"
                ? nativeResult.output
                : null,
          }
        : exhausted
          ? {
              status: "failed",
              reason: "execution-exhausted",
              runInformationId: run?.run_id ?? null,
              output: null,
            }
          : null);
    return {
      taskRequestId,
      environmentId,
      requestedInformationId: source.informationId,
      runInformationId: run?.run_id ?? null,
      status: result?.status ?? (run ? "running" : "queued"),
      terminal: result,
      cancellation: await this.deps.db.nativeTools.cancellation(
        nativeToolOrigin(request),
      ),
    };
  }
  async cancel(environmentId: string, taskRequestId: string) {
    const source = await this.source(environmentId, taskRequestId);
    if (!source) throw new Error("gui-task-not-found");
    await this.forwardCancellation(source);
    if (await this.slot("terminal", source.informationId))
      return this.read(environmentId, taskRequestId);
    const request = await this.request(source);
    const run = await this.deps.db.nativeTools.cancelOrigin(
      nativeToolOrigin(request),
      request.contextInformationId,
    );
    if (run) {
      const stopped = run.stopped_id
        ? await this.deps.core.get(run.stopped_id)
        : undefined;
      if (stopped?.payload.reason !== "cancelled")
        return this.read(environmentId, taskRequestId);
    }
    await this.forwardCancellation(source);
    await this.terminal(source, "stopped", "cancelled");
    return this.read(environmentId, taskRequestId);
  }
}
