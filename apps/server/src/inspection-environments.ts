/**
 * 功能概述：读取 GUI 任务原来源与现有宿主公开控制状态，不引入新的控制或调度 API。
 * guiTask 从持久来源、native 原点与终态解释状态；environment/humanOperation 只调用公开只读门面，
 * 不持有 lease/session 秘密，取消转发与任务停止分别返回。截图仍走原带认证二进制路由。
 * 代码库关系：server 注入 mcp-host 的只读环境门面；Inspection 复用统一管理认证与内容清理。
 */
import { actionDigest, type InspectionFact } from "@kaguya/database";
import {
  z,
  inspectionGuiTaskPageSchema,
  inspectionGuiTaskDetailSchema,
  inspectionEnvironmentSchema,
  inspectionHumanOperationSchema,
} from "@kaguya/schema";
import {
  DomainReader,
  parse,
  identifier,
  denied,
  InspectionDomainError,
  hasReference,
} from "./inspection-domain-common.js";
import { cancellation } from "./inspection-runs.js";

export interface InspectionEnvironmentSource {
  inspect(environmentId: string): Promise<unknown>;
  queryHuman(environmentId: string, operationId: string): Promise<unknown>;
}
const summary = (f: InspectionFact) => ({
  taskRequestId: f.payload.taskRequestId,
  environmentId: f.payload.environmentId,
  requestedInformationId: f.id,
  observationId: f.payload.observationId,
  actionRunInformationId: f.payload.turn.claimInformationId,
  generation: f.payload.generation,
  routeId: f.payload.selectionPolicy.routeId,
  at: f.at,
});
const environmentQuery = z.object({ scope: identifier }).strict();
export function environmentInspection(
  d: DomainReader,
  getHost: () => InspectionEnvironmentSource | undefined,
) {
  return {
    guiTasks: (input: unknown) =>
      d.read(input, "gui-tasks", async (r, q, meta, before, cursor) => {
        const facts = await r.facts(
            ["agent.gui.task.requested.v1"],
            q.scope,
            before,
            q.limit + 1,
          ),
          page = facts.slice(0, q.limit);
        return inspectionGuiTaskPageSchema.parse({
          ...meta,
          items: page.map(summary),
          nextCursor:
            facts.length > q.limit ? cursor(page.at(-1)!.position) : null,
          truncated: facts.length > q.limit,
        });
      }),
    guiTask: (id: string, input: unknown) =>
      d.read(input, `gui-task:${id}`, async (r, q, meta) => {
        const source = await r.fact(id);
        if (
          source?.kind !== "agent.gui.task.requested.v1" ||
          source.payload.scope !== q.scope
        )
          throw denied();
        const origin = {
          instanceId: source.payload.activation.instanceId,
          definitionId: source.payload.activation.definitionId,
          taskId: "agent.gui.execute",
          sourceInformationId: id,
        };
        const rows = await r.rows(
          `SELECT run_id,stopped_id FROM information_native_tool_runs WHERE spec->>'scope'=$1 AND spec->'origin'=$2::jsonb LIMIT 2`,
          [q.scope, JSON.stringify(origin)],
        );
        if (rows.length > 1)
          throw new InspectionDomainError(409, "inspection_identity_conflict");
        const run = rows[0];
        const terminals = await r.related(
          id,
          ["agent.gui.task.terminal.v1"],
          "core:status-of",
          2,
        );
        if (
          terminals.length > 1 ||
          terminals.some(
            (f) =>
              !hasReference(f, id, "core:caused-by") ||
              f.payload.runInformationId !== (run?.run_id ?? null),
          )
        )
          throw new InspectionDomainError(409, "inspection_identity_conflict");
        const terminal = terminals[0];
        const native = run?.stopped_id
          ? await r.fact(run.stopped_id)
          : undefined;
        const exhausted = (
          await r.rows(
            `SELECT information_id FROM information_commit_slots WHERE slot_type='terminal' AND namespace='execution.kaguya.gui.task' AND key=$1`,
            [id],
          )
        )[0];
        const nativeValid =
          native?.kind === "agent.heavy.tool.terminal.v1" &&
          native.payload.runInformationId === run?.run_id;
        const value =
          terminal?.payload ??
          (nativeValid
            ? {
                status:
                  native.payload.reason === "final" &&
                  native.payload.modelResult?.status === "completed"
                    ? "completed"
                    : native.payload.reason === "cancelled"
                      ? "stopped"
                      : "failed",
                reason: native.payload.reason,
                runInformationId: run!.run_id,
                output: native.payload.modelResult?.output ?? null,
              }
            : exhausted
              ? {
                  status: "failed",
                  reason: "execution-exhausted",
                  runInformationId: run?.run_id ?? null,
                  output: null,
                }
              : null);
        return inspectionGuiTaskDetailSchema.parse({
          ...meta,
          task: summary(source),
          run: run
            ? {
                domain: "run",
                id: run.run_id,
                relation: "native-run",
                availability: "available",
              }
            : null,
          status: value?.status ?? (run ? "running" : "queued"),
          terminal: value ? d.safe(value) : null,
          terminalSource: terminal
            ? "gui-task"
            : nativeValid
              ? "native-run"
              : exhausted
                ? "execution"
                : "unrecorded",
          cancellation: await cancellation(r, origin),
          references: [
            {
              domain: "observation",
              id: source.payload.observationId,
              relation: "task-observation",
              availability: (
                await r.observations(
                  q.scope,
                  null,
                  null,
                  1,
                  source.payload.observationId,
                )
              ).length
                ? "available"
                : "missing-or-denied",
            },
          ],
        });
      }),
    environment: async (id: string, input: unknown) => {
      const q = parse(environmentQuery, input),
        host = getHost();
      if (!host)
        throw new InspectionDomainError(
          503,
          "inspection_environment_unavailable",
        );
      const control = inspectionEnvironmentSchema.shape.control.parse(
        await host.inspect(id),
      );
      if (control.environmentId !== id || control.scope !== q.scope)
        throw denied();
      return d.finish(
        inspectionEnvironmentSchema.parse({
          version: 1,
          scope: q.scope,
          stateReadAt: new Date().toISOString(),
          control,
        }),
      );
    },
    humanOperation: async (id: string, operationId: string, input: unknown) => {
      const q = parse(environmentQuery, input),
        host = getHost();
      if (!host)
        throw new InspectionDomainError(
          503,
          "inspection_environment_unavailable",
        );
      const control = inspectionEnvironmentSchema.shape.control.parse(
        await host.inspect(id),
      );
      if (control.environmentId !== id || control.scope !== q.scope)
        throw denied();
      const receipt = z
        .object({
          operationId: z.string(),
          attemptId: z.string(),
          outcome: z.json(),
        })
        .parse(await host.queryHuman(id, operationId));
      if (receipt.operationId !== operationId) throw denied();
      return d.finish(
        inspectionHumanOperationSchema.parse({
          version: 1,
          scope: q.scope,
          stateReadAt: new Date().toISOString(),
          environmentId: id,
          operationId,
          attemptId: receipt.attemptId,
          outcome: d.safe(receipt.outcome),
        }),
      );
    },
  };
}
