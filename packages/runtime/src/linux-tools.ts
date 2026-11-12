/**
 * guiModel 显式选定独立 GUI 任务的模型路由；原生 GUI bind 要求此配置，人工控制仍独立使用已配置桌面。
 * readArtifact 只允许绑定环境与 scope，并向原生循环提供归档 blob，无截图副作用。
 * 功能概述：把显式宿主配置的 Linux shell/Chromium/GUI 工具接入 W4 原生目录和 W3/W6 执行边界。
 * LinuxToolsHost 延迟 acquire 并在 bind 前 renew；同一环境的绑定串行，保持秘密仅在 client 内存。
 * 取消在新进程中按当前配置取得控制租约，保留原 attempt；环境拒绝 acquire 时等待显式恢复，不自动接管。
 * snapshot 提供 shell.exec 的有界 schema、scope/target 授权与 broker provider，不另建工具循环。
 * close 释放所持 lease，W6 负责物理隔离；失败保留 owner 以便再次清理，禁止盲目 recover。
 * 管理接管与 lease 共享 scope 锁；人工输入不占用控制锁，使关闭/恢复可立即撤销正在执行的输入。
 * 代码库关系：Server 从敏感 linux-tools.json 构建此宿主；init/helper 实现 job 与真实 verify。
 */
import { z } from "@kaguya/schema";
import {
  LinuxEnvironmentClient,
  type ActionEnvironment,
  type HumanOperation,
} from "./environment.js";
import type { NativeToolLoopOptions } from "./native-tool-loop.js";
import type { ActionExecutorOptions } from "./action.js";
import {
  linuxBrowserObserveSchema,
  linuxBrowserActSchema,
  linuxBrowserVerifySchema,
} from "./linux-browser.js";
import {
  linuxGuiObserveSchema,
  linuxGuiActSchema,
  linuxGuiVerifySchema,
} from "./linux-gui.js";

const text = z.string().min(1).max(4096);
const jobId = z.string().regex(/^[a-f0-9]{64}$/);
const original = z.object({ operationId: text, attemptId: text }).strict();
export const linuxShellSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("start"),
      argv: z.array(z.string().max(32768)).min(1).max(128),
      cwd: text.default("."),
      env: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
  z.object({ mode: z.literal("query"), jobId }).strict(),
  z.object({ mode: z.literal("stop"), jobId }).strict(),
  z
    .object({
      mode: z.literal("verify"),
      original,
      jobId: jobId.optional(),
      path: text.optional(),
    })
    .strict()
    .refine((v) => Boolean(v.jobId) !== Boolean(v.path)),
  z
    .object({
      mode: z.literal("export"),
      jobId: jobId.optional(),
      stream: z.enum(["stdout", "stderr"]).optional(),
      path: text.optional(),
      mime: text.optional(),
      offset: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().min(1).max(16777216).optional(),
      sha256: jobId.optional(),
    })
    .strict()
    .refine((v) => Boolean(v.jobId && v.stream) !== Boolean(v.path)),
]);
export const linuxToolsConfigurationSchema = z
  .object({
    version: z.literal(1),
    revision: text,
    bindings: z
      .array(
        z
          .object({
            scope: text,
            environmentId: text,
            workflowId: text,
            browser: z.boolean().optional(),
            gui: z.boolean().optional(),
            guiModel: z
              .object({ routeId: text, providerId: text, modelId: text })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict()
  .refine(
    (v) =>
      v.bindings.every((b) => !b.guiModel || b.gui === true) &&
      new Set(
        v.bindings.flatMap((b) => (b.guiModel ? [b.guiModel.routeId] : [])),
      ).size === v.bindings.filter((b) => b.guiModel).length &&
      new Set(v.bindings.map((b) => b.scope)).size === v.bindings.length &&
      new Set(v.bindings.map((b) => b.environmentId)).size ===
        v.bindings.length,
  );
export type LinuxToolsConfiguration = z.infer<
  typeof linuxToolsConfigurationSchema
>;

export class LinuxToolsHost {
  private readonly leases = new Map<string, ActionEnvironment>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly unavailable = new Set<string>();
  private readonly manualBlocked = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly actionEnvironment: Required<
    Pick<
      ActionExecutorOptions,
      "resolveLeaseCredential" | "validateEnvironment"
    >
  >;
  constructor(
    readonly configuration: LinuxToolsConfiguration,
    readonly client = new LinuxEnvironmentClient(),
    private readonly ttlSeconds = 120,
  ) {
    linuxToolsConfigurationSchema.parse(configuration);
    this.actionEnvironment = {
      ...this.client.actionHooks,
      resolveLeaseCredential: async (input, mode) => {
        if (mode === "cancel") {
          const original = input.intent.environment;
          if (
            !input.controlAuthorizationId ||
            !original ||
            !this.configuration.bindings.some(
              (binding) =>
                binding.scope === input.intent.scope &&
                binding.environmentId === original.environmentId &&
                binding.workflowId === original.workflowId,
            )
          )
            throw new Error("linux-tools-cancel-binding-denied");
          await this.bind(input.intent.scope);
        }
        return this.client.actionHooks.resolveLeaseCredential(input, mode);
      },
    } satisfies Required<
      Pick<
        ActionExecutorOptions,
        "resolveLeaseCredential" | "validateEnvironment"
      >
    >;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300)
      throw new Error("invalid-host-lease-ttl");
    this.timer = setInterval(
      () => {
        void this.maintain();
      },
      (ttlSeconds * 1000) / 3,
    );
    this.timer.unref();
  }
  async maintain() {
    if (this.closed) return;
    await Promise.allSettled(
      [...this.leases.keys()]
        .filter((scope) => !this.unavailable.has(scope))
        .map((scope) =>
          this.bind(scope).catch(() => {
            this.unavailable.add(scope);
          }),
        ),
    );
  }
  async recover(
    scope: string,
    generation: number,
    controlAuthorizationId: string,
  ) {
    const config = this.configuration.bindings.find((b) => b.scope === scope);
    if (!config || this.closed) throw new Error("linux-tools-scope-denied");
    this.unavailable.add(scope);
    const work = (this.locks.get(scope) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await this.client.recover({
          environmentId: config.environmentId,
          scope,
          generation,
          controlAuthorizationId,
        });
        this.leases.delete(scope);
        this.unavailable.delete(scope);
      });
    this.locks.set(scope, work);
    await work;
  }
  async bind(scope: string): Promise<ActionEnvironment> {
    const config = this.configuration.bindings.find((b) => b.scope === scope);
    if (!config || this.closed || this.unavailable.has(scope))
      throw new Error("linux-tools-scope-denied");
    const previous = this.locks.get(scope) ?? Promise.resolve();
    const work = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.closed || this.unavailable.has(scope))
          throw new Error("linux-tools-closed");
        let reference = this.leases.get(scope);
        reference = reference
          ? await this.client.renew(
              config.environmentId,
              scope,
              this.ttlSeconds,
            )
          : await this.client.acquire({
              ...config,
              ttlSeconds: this.ttlSeconds,
            });
        this.leases.set(scope, reference);
        return structuredClone(reference);
      });
    this.locks.set(scope, work);
    return work;
  }

  private managed(environmentId: string) {
    const config = this.configuration.bindings.find(
      (binding) => binding.environmentId === environmentId && binding.gui,
    );
    if (!config || this.closed) throw new Error("linux-gui-management-denied");
    return config;
  }

  inspect(environmentId: string) {
    return this.client.inspect(
      environmentId,
      this.managed(environmentId).scope,
    );
  }

  private manage<T>(
    environmentId: string,
    operation: (scope: string) => Promise<T>,
  ) {
    const { scope } = this.managed(environmentId);
    this.unavailable.add(scope);
    this.manualBlocked.add(environmentId);
    const work = (this.locks.get(scope) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) throw new Error("linux-tools-closed");
        const result = await operation(scope);
        this.leases.delete(scope);
        return result;
      });
    this.locks.set(scope, work);
    return work;
  }

  handoff(
    environmentId: string,
    generation: number,
    controlAuthorizationId: string,
  ) {
    return this.manage(environmentId, async (scope) => {
      const result = await this.client.openHuman({
        environmentId,
        scope,
        generation,
        controlAuthorizationId,
      });
      this.manualBlocked.delete(environmentId);
      return result;
    });
  }

  resume(
    environmentId: string,
    generation: number,
    controlAuthorizationId: string,
  ) {
    return this.manage(environmentId, async (scope) => {
      await this.client.resume({
        environmentId,
        scope,
        generation,
        controlAuthorizationId,
      });
      const current = await this.client.inspect(environmentId, scope);
      if (current.state !== "ready" || current.generation !== generation + 1)
        throw new Error("linux-resume-unconfirmed");
      this.unavailable.delete(scope);
      return current;
    });
  }

  operateHuman(input: Omit<HumanOperation, "scope">) {
    const { scope } = this.managed(input.environmentId);
    if (this.manualBlocked.has(input.environmentId))
      throw new Error("human-session-unavailable");
    return this.client.operateHuman({ ...input, scope });
  }

  renewHuman(input: {
    environmentId: string;
    generation: number;
    sessionId: string;
  }) {
    if (this.manualBlocked.has(input.environmentId))
      throw new Error("human-session-unavailable");
    return this.client.renewHuman({
      ...input,
      scope: this.managed(input.environmentId).scope,
    });
  }

  closeHuman(input: {
    environmentId: string;
    generation: number;
    sessionId: string;
  }) {
    return this.manage(input.environmentId, (scope) =>
      this.client.closeHuman({ ...input, scope }),
    );
  }

  queryHuman(environmentId: string, operationId: string) {
    return this.client.queryHuman(
      environmentId,
      this.managed(environmentId).scope,
      operationId,
    );
  }

  readGuiArtifact(environmentId: string, id: string) {
    return this.client.readArtifact(
      id,
      this.managed(environmentId).scope,
      environmentId,
    );
  }
  snapshot() {
    const provider = this.client.provider();
    const declarations = [
      {
        id: "shell.exec",
        inputSchema: linuxShellSchema,
        readonly: false,
        description:
          "在独立 Linux workspace 启动持久 shell job，查询/停止 job，或核对/导出文件。start 的 accepted 不代表命令已退出；query 不续 job 许可，超期自动停止全树。",
      },
      {
        id: "browser.observe",
        inputSchema: linuxBrowserObserveSchema,
        readonly: true,
        description:
          "观察当前隔离 Chromium 页面，取得有期限的 DOM 节点和观察引用，可附当前视口截图。每次输入前重新观察。",
      },
      {
        id: "browser.act",
        inputSchema: linuxBrowserActSchema,
        readonly: false,
        description:
          "使用当前观察执行一次导航或 DOM 输入。旧观察、旧 lease 或旧 generation 不可复用；返回输入回执后仍须 verify 检查目标状态，未知结果不得重复点击。",
      },
      {
        id: "browser.verify",
        inputSchema: linuxBrowserVerifySchema,
        readonly: true,
        description:
          "在新操作中引用原 operationId/attemptId，读取真实页面状态或核对并导出下载当前文件；下载操作关联为启发式、因果未确认，不重放原输入。",
      },
      {
        id: "gui.observe",
        inputSchema: linuxGuiObserveSchema,
        readonly: true,
        description:
          "观察隔离 Linux 桌面或指定窗口，返回原尺寸 PNG、AX、窗口原点和一次性观察引用。像素坐标属于返回的窗口图或桌面图；每次输入前重新观察。",
      },
      {
        id: "gui.act",
        inputSchema: linuxGuiActSchema,
        readonly: false,
        description:
          "依据当前观察执行一次 GUI 输入。insert 只插入 ASCII；replace 明确替换整个字段并支持 Unicode。未知结果不得重复输入；过期观察、旧 generation 或已撤销许可均拒绝。",
      },
      {
        id: "gui.verify",
        inputSchema: linuxGuiVerifySchema,
        readonly: true,
        description:
          "引用原 operationId/attemptId，重新观察并核对当前 GUI 文本，不重放原输入，不改写原操作的未知结果。",
      },
    ].filter(
      (tool) =>
        tool.id === "shell.exec" ||
        this.configuration.bindings.some((b) =>
          tool.id.startsWith("gui.")
            ? b.gui === true && Boolean(b.guiModel)
            : b.browser === true,
        ),
    );
    const tools: NativeToolLoopOptions = {
      guiTasks: {
        bindings: this.configuration.bindings.flatMap((b) =>
          b.guiModel
            ? [
                {
                  environmentId: b.environmentId,
                  scope: b.scope,
                  workflowId: b.workflowId,
                  routeId: b.guiModel.routeId,
                  revision: this.configuration.revision,
                },
              ]
            : [],
        ),
        inspect: (environmentId) => this.inspect(environmentId),
        validate: async (input) => {
          if (
            this.closed ||
            this.unavailable.has(input.scope) ||
            this.manualBlocked.has(input.environmentId) ||
            !this.configuration.bindings.some(
              (b) =>
                b.gui &&
                b.guiModel &&
                b.environmentId === input.environmentId &&
                b.scope === input.scope &&
                b.workflowId === input.workflowId,
            )
          )
            return false;
          try {
            const state = await this.inspect(input.environmentId);
            return (
              state.state === "ready" && state.generation === input.generation
            );
          } catch {
            return false;
          }
        },
      },
      readArtifact: ({ id, scope, environmentId }) => {
        if (
          !this.configuration.bindings.some(
            (b) =>
              b.gui && b.scope === scope && b.environmentId === environmentId,
          )
        )
          throw new Error("native-image-scope-denied");
        return this.client.readArtifact(id, scope, environmentId);
      },
      registrations: this.configuration.bindings.length
        ? declarations.map((tool) => ({
            id: tool.id,
            version: "1",
            description: tool.description,
            providerId: provider.id,
            providerVersion: provider.version,
            executor: "linux",
            readonly: tool.readonly,
            independent: false,
            policyVersion: this.configuration.revision,
            inputSchema: tool.inputSchema,
            bind: async ({ scope }) => {
              if (
                tool.id !== "shell.exec" &&
                !this.configuration.bindings.some(
                  (b) =>
                    b.scope === scope &&
                    (tool.id.startsWith("gui.")
                      ? b.gui === true && Boolean(b.guiModel)
                      : b.browser === true),
                )
              )
                throw new Error(
                  tool.id.startsWith("gui.")
                    ? "linux-gui-scope-denied"
                    : "linux-browser-scope-denied",
                );
              return {
                target: { scope, revision: this.configuration.revision },
                environment: await this.bind(scope),
              };
            },
            authorize: async ({ intent }) =>
              !this.closed &&
              !this.unavailable.has(intent.scope) &&
              this.configuration.bindings.some(
                (b) =>
                  b.scope === intent.scope &&
                  (tool.id === "shell.exec" ||
                    (tool.id.startsWith("gui.")
                      ? b.gui === true
                      : b.browser === true)) &&
                  b.environmentId === intent.environment?.environmentId &&
                  b.workflowId === intent.environment.workflowId,
              ) &&
              intent.target.scope === intent.scope &&
              intent.target.revision === this.configuration.revision &&
              intent.providerId === provider.id &&
              intent.executor === "linux",
          }))
        : [],
      tasks: this.configuration.bindings.length
        ? [
            {
              definitionId: "agent.heavy",
              taskId: "agent.heavy.respond",
              toolIds: declarations
                .filter((tool) => !tool.id.startsWith("gui."))
                .map((tool) => tool.id),
            },
            ...this.configuration.bindings.flatMap((b) =>
              b.guiModel
                ? [
                    {
                      definitionId: "agent.heavy",
                      taskId: "agent.gui.execute",
                      routeId: b.guiModel.routeId,
                      toolIds: declarations
                        .filter((tool) => tool.id.startsWith("gui."))
                        .map((tool) => tool.id),
                    },
                  ]
                : [],
            ),
          ]
        : [],
    };
    return {
      nativeTools: tools,
      actionProviders: tools.registrations.length ? [provider] : [],
      actionEnvironment: this.actionEnvironment,
    };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.locks.values());
    await this.client.closeOwnedInputs();
    this.leases.clear();
  }
}
