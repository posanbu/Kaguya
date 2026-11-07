/**
 * 功能概述：把显式 MCP 连接装配为宿主工具注册和 W3 provider，资源与 prompt 保持独立权限。
 * McpHost.open 完整发现后返回不可变注册快照；reconnect 不改变已发出的定义；provider 执行前复核摘要。
 * resources 按需 list/templates/read；selectPrompt 只供可信用户控制入口调用，getPrompt 消耗一次性选择。
 * 结果保留远端内容、来源和独立请求 ID；未知副作用交 W3 核对，cancel 只中断传输，不谎称远端已取消。
 * 成功结果按冻结outputSchema复核；isError保留错误正文及partial/returned，不套用成功结果格式。
 * close保留各connection的脱敏清理cause，外层稳定错误码继续供Server识别。
 * Runtime/Server 注入注册项和 provider；本类不持有数据库、不运行模型、不自行授予跨 scope 权限。
 */
import { randomUUID } from "node:crypto";
import type {
  NativeToolRegistration,
  NativeToolLoopOptions,
} from "@kaguya/runtime";
import type {
  ActionProvider,
  ActionExecution,
  ActionOutcome,
} from "@kaguya/sdk";
import type { JsonObject, JsonValue } from "@kaguya/schema";
import {
  McpConnection,
  type McpEnvelope,
  type McpToolDefinition,
} from "./connection.js";
import {
  McpError,
  cleanupCause,
  digest,
  mcpConfigurationSchema,
  type McpConfiguration,
} from "./config.js";

declare const promptSelectionBrand: unique symbol;
export type McpPromptSelection = { readonly [promptSelectionBrand]: true };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export class McpHost {
  private readonly connections = new Map<string, McpConnection>();
  private readonly selections = new WeakMap<
    McpPromptSelection,
    {
      connectionId: string;
      revision: string;
      name: string;
      arguments: Record<string, string>;
      scope: string;
      expiresAt: number;
      selectionId: string;
    }
  >();
  private readonly active = new Map<string, AbortController>();
  private registrations: NativeToolRegistration[] = [];
  private providers: ActionProvider[] = [];
  private closed = false;
  private constructor() {}
  static async open(
    configuration: McpConfiguration,
    resolveSecret: (reference: string) => string | undefined = (reference) =>
      process.env[reference],
    options: {
      ownershipDirectory?: string;
      recordLateResult?: (
        envelope: McpEnvelope,
        informationId: string,
      ) => Promise<void>;
    } = {},
  ) {
    const parsed = mcpConfigurationSchema.safeParse(configuration);
    if (!parsed.success) throw new McpError("mcp-configuration-invalid");
    const host = new McpHost();
    try {
      for (const config of parsed.data.connections.filter(
        (config) => config.enabled,
      )) {
        const connection = new McpConnection(
          config,
          resolveSecret,
          options.ownershipDirectory,
          options.recordLateResult,
        );
        host.connections.set(config.id, connection);
        await connection.connect();
        host.install(connection);
      }
      return host;
    } catch (error) {
      await host.close();
      throw error;
    }
  }
  private install(connection: McpConnection) {
    const config = connection.config;
    const providerId = `mcp.${config.id}`,
      executor = `mcp:${config.id}`;
    const definitions = new Map(
      connection
        .definitions()
        .map((definition) => [definition.tool.name, definition]),
    );
    for (const definition of definitions.values()) {
      const policy = config.tools.find(
        (tool) => tool.name === definition.tool.name,
      )!;
      const target = {
        connectionId: config.id,
        connectionRevision: connection.revision,
        protocol: config.protocol,
        originalToolName: definition.tool.name,
        definitionRevision: definition.revision,
      };
      const authorize = (intent: ActionExecution["intent"]) =>
        !this.closed &&
        config.scopes.includes(intent.scope) &&
        digest(intent.target) === digest(target) &&
        connection.definition(definition.tool.name)?.revision ===
          definition.revision;
      this.registrations.push({
        id: `mcp.${config.id}.${definition.tool.name}`,
        version: definition.revision,
        description:
          definition.tool.description?.slice(0, 4000) ||
          `MCP ${definition.tool.name}`,
        providerId,
        providerVersion: connection.revision,
        executor,
        policyVersion: config.revision,
        readonly: policy.readonly,
        independent: policy.independent,
        jsonSchema: copy(definition.tool.inputSchema) as Record<
          string,
          JsonValue
        >,
        validateInput: (input) => definition.validate(input),
        bind: async ({ scope }) => {
          connection.assertScope(scope);
          return { target: copy(target) };
        },
        authorize: async ({ intent, mode }) =>
          mode === "cancel"
            ? config.scopes.includes(intent.scope)
            : authorize(intent),
      });
    }
    this.providers.push({
      id: providerId,
      version: connection.revision,
      capabilities: {
        cancellation: "none",
        idempotency: "none",
        reconciliation: false,
        successEvidence: "returned",
        fencing: "none",
      },
      execute: (input) => this.execute(connection, definitions, input),
      cancel: async (input) => {
        this.active.get(input.attemptId)?.abort();
        return undefined;
      },
    });
  }
  private outcome(
    status: ActionOutcome["status"],
    evidence: ActionOutcome["evidence"],
    result: unknown,
  ): ActionOutcome {
    return {
      status,
      evidence,
      result: copy(result) as JsonValue,
      artifacts: [],
      truncated: false,
    };
  }
  private async execute(
    connection: McpConnection,
    definitions: Map<string, McpToolDefinition>,
    input: ActionExecution,
  ): Promise<ActionOutcome> {
    const target = input.intent.target;
    const definition = definitions.get(String(target.originalToolName));
    if (
      this.closed ||
      !definition ||
      target.connectionId !== connection.config.id ||
      target.connectionRevision !== connection.revision ||
      target.protocol !== connection.config.protocol ||
      target.definitionRevision !== definition.revision ||
      connection.definition(definition.tool.name)?.revision !==
        definition.revision ||
      !connection.config.scopes.includes(input.intent.scope) ||
      !definition.validate(input.intent.arguments)
    )
      return this.outcome("rejected", "not-executed", {
        reason: "mcp-definition-or-permission-unavailable",
      });
    const controller = new AbortController();
    this.active.set(input.attemptId, controller);
    try {
      // 固定 toolDefinition 禁止 SDK 在 HEADER_MISMATCH 后刷新目录并重新 tools/call。
      const envelope = await connection.request(
        "tools/call",
        input.intent.scope,
        (client, options) =>
          client.callTool(
            { name: definition.tool.name, arguments: input.intent.arguments },
            { ...options, toolDefinition: definition.tool },
          ),
        {
          definitionRevision: definition.revision,
          modelToolCallId: input.intent.toolCallId ?? null,
          operationId: input.operationId,
          attemptId: input.attemptId,
          intentId: input.intentId,
        },
        AbortSignal.any([
          input.signal,
          controller.signal,
          AbortSignal.timeout(
            Math.max(1, Date.parse(input.intent.deadline) - Date.now()),
          ),
        ]),
      );
      const value = envelope.value as {
        isError?: boolean;
        structuredContent?: unknown;
      };
      if (
        !value.isError &&
        definition.tool.outputSchema &&
        value.structuredContent !== undefined &&
        !definition.validateOutput?.(value.structuredContent)
      )
        return this.outcome("unknown", "unconfirmed", {
          ...envelope,
          reason: "mcp-output-schema-invalid",
        });
      // 服务端 isError 不证明没有部分副作用，因此停止循环并保留原返回。
      return this.outcome(
        value.isError ? "partial" : "succeeded",
        "returned",
        envelope,
      );
    } catch (error) {
      const envelope =
        error && typeof error === "object" && "envelope" in error
          ? error.envelope
          : { reason: "mcp-request-unconfirmed" };
      return this.outcome("unknown", "unconfirmed", envelope);
    } finally {
      this.active.delete(input.attemptId);
    }
  }
  snapshot(): {
    nativeTools: NativeToolLoopOptions;
    actionProviders: readonly ActionProvider[];
  } {
    return {
      nativeTools: {
        registrations: [...this.registrations],
        tasks: [
          {
            taskId: "agent.heavy.respond",
            definitionId: "agent.heavy",
            toolIds: this.registrations.map((tool) => tool.id),
          },
        ],
      },
      actionProviders: [...this.providers],
    };
  }
  private connection(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (this.closed || !connection)
      throw new McpError("mcp-connection-unavailable");
    return connection;
  }
  status() {
    return [...this.connections].map(([connectionId, connection]) => ({
      connectionId,
      revision: connection.revision,
      protocol: connection.config.protocol,
      pid: connection.pid,
      tools: connection.definitions().map((definition) => ({
        name: definition.tool.name,
        revision: definition.revision,
      })),
    }));
  }
  async reconnect(connectionId: string) {
    const connection = this.connection(connectionId);
    await connection.reconnect();
    this.registrations = this.registrations.filter(
      (tool) => tool.providerId !== `mcp.${connectionId}`,
    );
    this.providers = this.providers.filter(
      (provider) => provider.id !== `mcp.${connectionId}`,
    );
    this.install(connection);
  }
  async listResources(connectionId: string, scope: string) {
    return this.connection(connectionId).list("resources", scope);
  }
  async listResourceTemplates(connectionId: string, scope: string) {
    return this.connection(connectionId).list("templates", scope);
  }
  async readResource(connectionId: string, scope: string, uri: string) {
    const connection = this.connection(connectionId);
    connection.assertScope(scope);
    if (
      !connection.config.resourceUriPrefixes.some((prefix) =>
        uri.startsWith(prefix),
      )
    )
      throw new McpError("mcp-resource-denied");
    const result = await connection.request(
      "resources/read",
      scope,
      (client, options) =>
        client.readResource({ uri }, { ...options, cacheMode: "bypass" }),
    );
    const contents = (result.value as { contents?: { uri: string }[] })
      .contents;
    if (
      !contents?.every((content) =>
        connection.config.resourceUriPrefixes.some((prefix) =>
          content.uri.startsWith(prefix),
        ),
      )
    )
      throw new McpError("mcp-resource-result-denied");
    return result;
  }
  async listPrompts(connectionId: string, scope: string) {
    return this.connection(connectionId).list("prompts", scope);
  }
  /** 仅由已验证用户交互的宿主控制入口调用；该方法不进入模型工具目录。 */
  selectPrompt(input: {
    connectionId: string;
    scope: string;
    name: string;
    arguments: Record<string, string>;
  }): McpPromptSelection {
    const connection = this.connection(input.connectionId);
    connection.assertScope(input.scope);
    if (!connection.config.prompts.includes(input.name))
      throw new McpError("mcp-prompt-denied");
    const token = {} as McpPromptSelection;
    this.selections.set(token, {
      ...copy(input),
      revision: connection.revision,
      selectionId: randomUUID(),
      expiresAt: Date.now() + 300000,
    });
    return token;
  }
  async getPrompt(selection: McpPromptSelection): Promise<McpEnvelope> {
    const chosen = this.selections.get(selection);
    this.selections.delete(selection);
    if (!chosen || chosen.expiresAt <= Date.now())
      throw new McpError("mcp-user-selection-required");
    const connection = this.connection(chosen.connectionId);
    if (connection.revision !== chosen.revision)
      throw new McpError("mcp-user-selection-expired");
    const envelope = await connection.request(
      "prompts/get",
      chosen.scope,
      (client, options) =>
        client.getPrompt(
          { name: chosen.name, arguments: chosen.arguments },
          options,
        ),
    );
    return {
      ...envelope,
      value: { selectionId: chosen.selectionId, prompt: envelope.value },
    };
  }
  async close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    const results = await Promise.allSettled(
      [...this.connections.entries()].map(
        async ([connectionId, connection]) => {
          try {
            await connection.close();
          } catch (error) {
            throw new McpError("mcp-connection-cleanup-failed", {
              details: { connectionId, stage: "connection-close" },
              cause: cleanupCause(error),
            });
          }
        },
      ),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new McpError("mcp-cleanup-failed", {
        cause: new AggregateError(
          results
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason),
          "mcp-cleanup-causes",
        ),
      });
  }
}
