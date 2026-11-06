/**
 * 功能概述：维护显式协议的 MCP 连接，原子发布有界目录并保留请求来源。
 * connect/reconnect 只恢复连接和目录，不重放行动；request 分开记录 JSON-RPC 与模型 call ID。
 * 分页将 cursor 作为不透明字符串转发，空字符串也不能省略。
 * tools 使用冻结的原始 schema；结果保留 scope、时间、定义摘要和不可信来源标记。
 * 凭据脱敏包括认证头中的Bearer/Basic参数及JSON键；每次派发冻结同一凭据集合供迟到证据使用。
 * close独立保留transport回收和late持久化错误的脱敏cause；中断请求并回收进程；凭据只在宿主闭包解析，HTTP 禁止重定向、OAuth 和自动重连。
 */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
  type JSONRPCMessage,
  type TransportSendOptions,
  type Tool,
  type RequestOptions,
} from "@modelcontextprotocol/client";
import {
  McpError,
  cleanupCause,
  connectionRevision,
  digest,
  type McpConnectionConfig,
} from "./config.js";
import { SingleProcessStdio } from "./stdio.js";

export interface McpRequestTrace {
  rpcId: string | number;
  method: string;
  modelToolCallId: string | null;
  operationId: string | null;
  attemptId: string | null;
  intentId: string | null;
}
export interface McpSource {
  connectionId: string;
  connectionRevision: string;
  protocol: string;
  scope: string;
  definitionRevision: string | null;
  observedAt: string;
  trust: "untrusted-mcp-data";
  transportGeneration: string;
}
export interface McpEnvelope {
  source: McpSource;
  requests: McpRequestTrace[];
  value: unknown;
}
export interface McpToolDefinition {
  tool: Tool;
  revision: string;
  validate(input: unknown): boolean;
  validateOutput?: (output: unknown) => boolean;
}
interface Invocation {
  scope: string;
  definitionRevision: string | null;
  modelToolCallId: string | null;
  operationId: string | null;
  attemptId: string | null;
  intentId: string | null;
  requests: McpRequestTrace[];
  signal?: AbortSignal;
  rawResponse?: unknown;
  transportGeneration?: string;
  secrets: string[];
}
const invocation = new AsyncLocalStorage<Invocation>();
const baseEnvironment = () =>
  Object.fromEntries(
    ["PATH", "SYSTEMROOT", "SystemRoot", "PATHEXT", "TEMP", "TMP"].flatMap(
      (key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  );
function compileSchema(schema: Record<string, unknown>) {
  const options = {
    strict: false,
    allErrors: false,
    validateFormats: false,
    removeAdditional: false,
    useDefaults: false,
    coerceTypes: false,
  };
  const validator =
    typeof schema.$schema === "string" && /draft-07/.test(schema.$schema)
      ? new Ajv(options)
      : new Ajv2020(options);
  const validate = validator.compile(schema as AnySchema);
  return (value: unknown) => Boolean(validate(value));
}

export class McpConnection {
  private client: Client | undefined;
  private transport: Transport | undefined;
  private process: SingleProcessStdio | undefined;
  private stopped = false;
  private ready = false;
  private connecting: Promise<void> | undefined;
  private tools: ReadonlyMap<string, McpToolDefinition> = new Map();
  private controllers = new Set<AbortController>();
  private work = new Set<Promise<unknown>>();
  private secretValues: string[] = [];
  private credentialDigest: string | undefined;
  private catalogValid = false;
  private catalogEpoch = 0;
  private reconnecting: Promise<void> | undefined;
  private lateRecords = new Map<
    string,
    { envelope: McpEnvelope; pending: Promise<void> | undefined }
  >();
  readonly revision: string;
  constructor(
    readonly config: McpConnectionConfig,
    private readonly resolveSecret: (reference: string) => string | undefined,
    private readonly ownershipDirectory?: string,
    private readonly recordLateResult?: (
      envelope: McpEnvelope,
      informationId: string,
    ) => Promise<void>,
  ) {
    this.revision = connectionRevision(config);
  }
  get pid() {
    return this.process?.pid ?? null;
  }
  definitions() {
    return this.catalogValid ? [...this.tools.values()] : [];
  }
  definition(name: string) {
    return this.catalogValid ? this.tools.get(name) : undefined;
  }
  assertScope(scope: string) {
    if (!this.config.scopes.includes(scope))
      throw new McpError("mcp-scope-denied");
  }
  private credentials() {
    const references =
      this.config.transport.type === "stdio"
        ? this.config.transport.envRefs
        : this.config.transport.headerRefs;
    const values = Object.fromEntries(
      Object.entries(references).map(([key, reference]) => {
        const value = this.resolveSecret(reference);
        if (!value || /[\r\n]/.test(value))
          throw new McpError("mcp-credential-unavailable");
        return [key, value];
      }),
    );
    const next = digest(values);
    if (this.credentialDigest !== undefined && next !== this.credentialDigest)
      throw new McpError("mcp-credential-revision-changed");
    this.credentialDigest = next;
    this.secretValues = [
      ...new Set(
        Object.entries(values).flatMap(([key, value]) => {
          const token =
            this.config.transport.type === "http" &&
            /^(?:proxy-)?authorization$/i.test(key)
              ? /^(?:Bearer|Basic)[ \t]+(\S+)$/i.exec(value)?.[1]
              : undefined;
          return token ? [value, token] : [value];
        }),
      ),
    ].sort((a, b) => b.length - a.length);
    return values;
  }
  sanitize(value: unknown, secrets = this.secretValues): unknown {
    if (typeof value === "string") {
      let text = value;
      for (const secret of secrets)
        for (const literal of [secret, encodeURIComponent(secret)])
          text = text.split(literal).join("[REDACTED]");
      return text;
    }
    if (Array.isArray(value))
      return value.map((item) => this.sanitize(item, secrets));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          this.sanitize(key, secrets),
          /^(authorization|cookie|set-cookie|password|apiKey|accessToken|refreshToken)$/i.test(
            key,
          )
            ? "[REDACTED]"
            : this.sanitize(item, secrets),
        ]),
      );
    return value;
  }
  private tracked(inner: Transport): Transport {
    const generation = randomUUID();
    const pendingTools = new Map<string, Invocation>();
    const outer: Transport = {
      get sessionId() {
        return inner.sessionId;
      },
      get hasPerRequestStream() {
        return inner.hasPerRequestStream ?? false;
      },
      start: async () => {
        inner.onmessage = (message, extra) => {
          if (!("method" in message) && "id" in message) {
            const key = JSON.stringify(message.id),
              context = pendingTools.get(key);
            pendingTools.delete(key);
            if (context) {
              context.rawResponse = this.sanitize(message, context.secrets);
              if (
                Buffer.byteLength(JSON.stringify(context.rawResponse)) >
                this.config.maxBytes
              )
                context.rawResponse = { reason: "mcp-response-budget" };
              if (context.signal?.aborted && this.recordLateResult) {
                const id = randomUUID();
                this.lateRecords.set(id, {
                  envelope: structuredClone(
                    this.envelope(context, context.rawResponse),
                  ),
                  pending: undefined,
                });
                void this.persistLate(id).catch(() => undefined);
              }
            }
          }
          outer.onmessage?.(message, extra);
        };
        inner.onclose = () => {
          this.ready = false;
          outer.onclose?.();
        };
        inner.onerror = () =>
          outer.onerror?.(new McpError("mcp-transport-failed"));
        await inner.start();
      },
      close: () => inner.close(),
      send: async (message: JSONRPCMessage, options?: TransportSendOptions) => {
        if ("method" in message && "id" in message) {
          const context = invocation.getStore();
          if (context) context.transportGeneration = generation;
          context?.requests.push({
            rpcId: message.id,
            method: message.method,
            modelToolCallId: context.modelToolCallId,
            operationId: context.operationId,
            attemptId: context.attemptId,
            intentId: context.intentId,
          });
          if (context && message.method === "tools/call") {
            if (
              pendingTools.size >= this.config.maxItems ||
              this.lateRecords.size >= this.config.maxItems
            )
              throw new McpError("mcp-request-journal-budget");
            pendingTools.set(JSON.stringify(message.id), context);
          }
        }
        await inner.send(message, options);
      },
      setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
    };
    // 保留公开 stdio 特征，使现代 discover 在同一 transport 上完成。
    if (inner instanceof SingleProcessStdio)
      Object.defineProperties(outer, {
        pid: { get: () => inner.pid },
        stderr: { get: () => inner.stderr },
      });
    return outer;
  }
  connect(): Promise<void> {
    if (this.stopped)
      return Promise.reject(new McpError("mcp-connection-closed"));
    if (this.ready) return Promise.resolve();
    return (this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    }));
  }
  private async open() {
    const epoch = this.catalogEpoch;
    const credentials = this.credentials();
    const client = new Client(
      { name: "kaguya", version: "1.0.0" },
      {
        supportedProtocolVersions: [this.config.protocol],
        versionNegotiation: {
          mode:
            this.config.protocol === "2026-07-28"
              ? { pin: "2026-07-28" }
              : "legacy",
          probe: { maxRetries: 0 },
        },
        capabilities: {},
        enforceStrictCapabilities: true,
        inputRequired: { autoFulfill: false },
        listMaxPages: this.config.maxPages,
      },
    );
    // 仅失效，不自动刷新、不打开 subscriptions/listen，也不替换当前 run 的定义。
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      this.catalogValid = false;
      this.catalogEpoch++;
    });
    const transportConfig = this.config.transport;
    let inner: Transport;
    if (transportConfig.type === "stdio") {
      this.process = new SingleProcessStdio({
        command: transportConfig.command,
        args: transportConfig.args,
        ...(transportConfig.cwd ? { cwd: transportConfig.cwd } : {}),
        ...(this.ownershipDirectory
          ? { ownershipDirectory: this.ownershipDirectory }
          : {}),
        env: { ...baseEnvironment(), ...credentials },
        maxBytes: this.config.maxBytes,
      });
      inner = this.process;
    } else {
      inner = new StreamableHTTPClientTransport(new URL(transportConfig.url), {
        requestInit: { headers: credentials, redirect: "error" },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
        fetch: async (url, init) => {
          // 首版没有服务端通知订阅；legacy initialized 后的可选 GET 不出网。
          if (init?.method === "GET")
            return new Response(null, { status: 405 });
          if (
            typeof init?.body === "string" &&
            Buffer.byteLength(init.body) > this.config.maxBytes
          )
            throw new McpError("mcp-request-budget");
          const requestSignal = invocation.getStore()?.signal;
          const signal = AbortSignal.any([
            AbortSignal.timeout(this.config.timeoutMs),
            ...(init?.signal ? [init.signal] : []),
            ...(requestSignal ? [requestSignal] : []),
          ]);
          const response = await fetch(url, {
            ...init,
            signal,
            redirect: "error",
          });
          const limit = this.config.maxBytes;
          if (Number(response.headers.get("content-length")) > limit) {
            await response.body?.cancel();
            throw new McpError("mcp-response-budget");
          }
          let bytes = 0;
          const body = response.body?.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                bytes += chunk.byteLength;
                if (bytes > limit) throw new McpError("mcp-response-budget");
                controller.enqueue(chunk);
              },
            }),
          );
          return new Response(body ?? null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      });
    }
    this.transport = this.tracked(inner);
    this.client = client;
    try {
      await client.connect(this.transport, { timeout: this.config.timeoutMs });
      if (this.stopped) throw new McpError("mcp-connection-closed");
      const next = new Map<string, McpToolDefinition>();
      const seenNames = new Set<string>();
      if (client.getServerCapabilities()?.tools) {
        const discovered = await this.pages("tools/list", {
          signal: AbortSignal.timeout(this.config.timeoutMs),
          timeout: this.config.timeoutMs,
          maxTotalTimeout: this.config.timeoutMs,
        });
        for (const raw of discovered as Tool[]) {
          if (seenNames.has(raw.name))
            throw new McpError("mcp-directory-conflict");
          seenNames.add(raw.name);
          const configured = this.config.tools.find(
            (policy) => policy.name === raw.name,
          );
          if (!configured) continue;
          const tool = structuredClone(raw);
          if (digest(this.sanitize(tool)) !== digest(tool))
            throw new McpError("mcp-definition-returned-credential");
          if (tool.inputSchema.type !== "object")
            throw new McpError("mcp-schema-unsupported");
          const validate = compileSchema(tool.inputSchema);
          const validateOutput = tool.outputSchema
            ? compileSchema(tool.outputSchema)
            : undefined;
          const revision = digest({
            connection: this.revision,
            tool,
            policy: configured,
          });
          next.set(tool.name, {
            tool,
            revision,
            validate,
            ...(validateOutput ? { validateOutput } : {}),
          });
        }
      }
      if (this.stopped || epoch !== this.catalogEpoch)
        throw new McpError("mcp-discovery-invalidated");
      this.tools = next;
      this.catalogValid = true;
      this.ready = true;
    } catch {
      this.ready = false;
      await inner.close();
      throw new McpError("mcp-connect-failed");
    }
  }
  reconnect(): Promise<void> {
    return (this.reconnecting ??= this.reopen().finally(() => {
      this.reconnecting = undefined;
    }));
  }
  private async reopen() {
    if (this.stopped) throw new McpError("mcp-connection-closed");
    this.ready = false;
    this.catalogValid = false;
    this.catalogEpoch++;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.work]);
    await this.transport?.close();
    await this.flushLate();
    await this.connect();
  }
  private async pages(
    method:
      | "tools/list"
      | "resources/list"
      | "resources/templates/list"
      | "prompts/list",
    options: RequestOptions,
  ) {
    const key =
      method === "tools/list"
        ? "tools"
        : method === "resources/list"
          ? "resources"
          : method === "prompts/list"
            ? "prompts"
            : "resourceTemplates";
    const seen = new Set<string>(),
      items: unknown[] = [];
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < this.config.maxPages; page++) {
      // 公共 request 是单页请求；不走 listTools() 的自动聚合/缓存路径。
      const result = (await this.client!.request(
        { method, params: cursor !== undefined ? { cursor } : {} },
        options,
      )) as unknown as Record<string, unknown>;
      bytes += Buffer.byteLength(JSON.stringify(result));
      if (bytes > this.config.maxBytes || !Array.isArray(result[key]))
        throw new McpError("mcp-directory-budget");
      items.push(...(result[key] as unknown[]));
      if (items.length > this.config.maxItems)
        throw new McpError("mcp-directory-budget");
      if (result.nextCursor === undefined) return items;
      if (typeof result.nextCursor !== "string" || seen.has(result.nextCursor))
        throw new McpError("mcp-pagination-invalid");
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw new McpError("mcp-pagination-budget");
  }
  request<T>(
    method: string,
    scope: string,
    perform: (client: Client, options: RequestOptions) => Promise<T>,
    context: Partial<Invocation> = {},
    signal?: AbortSignal,
  ): Promise<McpEnvelope> {
    this.assertScope(scope);
    if (!this.ready || !this.client || this.stopped)
      throw new McpError("mcp-connection-unavailable");
    const controller = new AbortController();
    this.controllers.add(controller);
    // 一个请求的总预算覆盖所有分页，不因每页或 progress 重新计时。
    const combined = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.config.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const state: Invocation = {
      scope,
      definitionRevision: null,
      modelToolCallId: null,
      operationId: null,
      attemptId: null,
      intentId: null,
      requests: [],
      ...context,
      signal: combined,
      secrets: [...this.secretValues],
    };
    const work = invocation.run(state, async () => {
      try {
        const value = await perform(this.client!, {
          signal: combined,
          timeout: this.config.timeoutMs,
          maxTotalTimeout: this.config.timeoutMs,
        });
        if (combined.aborted) throw new McpError("mcp-request-interrupted");
        if (Buffer.byteLength(JSON.stringify(value)) > this.config.maxBytes)
          throw new McpError("mcp-response-budget");
        return this.envelope(state, this.sanitize(value, state.secrets));
      } catch {
        throw Object.assign(new McpError("mcp-request-unconfirmed"), {
          envelope: this.envelope(state, {
            reason: "mcp-request-unconfirmed",
            response: state.rawResponse ?? null,
          }),
        });
      } finally {
        this.controllers.delete(controller);
      }
    });
    this.work.add(work);
    void work.finally(() => this.work.delete(work)).catch(() => undefined);
    return work;
  }
  private persistLate(id: string): Promise<void> {
    const record = this.lateRecords.get(id);
    if (!record) return Promise.resolve();
    return (record.pending ??= Promise.resolve()
      .then(() => this.recordLateResult!(record.envelope, id))
      .then(() => {
        this.lateRecords.delete(id);
      })
      .finally(() => {
        record.pending = undefined;
      }));
  }
  private async flushLate() {
    const result = await Promise.allSettled(
      [...this.lateRecords.keys()].map((id) => this.persistLate(id)),
    );
    if (result.some((item) => item.status === "rejected"))
      throw new McpError("mcp-late-result-persistence-unconfirmed");
  }
  private envelope(state: Invocation, value: unknown): McpEnvelope {
    return {
      source: {
        connectionId: this.config.id,
        connectionRevision: this.revision,
        protocol: this.config.protocol,
        scope: state.scope,
        definitionRevision: state.definitionRevision,
        observedAt: new Date().toISOString(),
        trust: "untrusted-mcp-data",
        transportGeneration: state.transportGeneration ?? "unissued",
      },
      requests: state.requests,
      value,
    };
  }
  async list(kind: "resources" | "templates" | "prompts", scope: string) {
    const capability = kind === "prompts" ? "prompts" : "resources";
    if (!this.client?.getServerCapabilities()?.[capability])
      throw new McpError("mcp-capability-unsupported");
    const method =
      kind === "resources"
        ? "resources/list"
        : kind === "templates"
          ? "resources/templates/list"
          : "prompts/list";
    return this.request(method, scope, async (_client, options) =>
      this.pages(method, options),
    );
  }
  async close() {
    this.stopped = true;
    this.ready = false;
    this.catalogValid = false;
    for (const controller of this.controllers) controller.abort();
    const cleanup = await Promise.allSettled([this.transport?.close()]);
    // 关闭等待建立/重连和所有请求结束；主动中断的握手失败不冒充资源释放失败。
    await Promise.allSettled([
      this.connecting,
      this.reconnecting,
      ...this.work,
    ]);
    const late = await Promise.allSettled([this.flushLate()]);
    const failures = [...cleanup, ...late].filter(
      (result) => result.status === "rejected",
    );
    if (failures.length)
      throw new McpError("mcp-connection-cleanup-failed", {
        cause: new AggregateError(
          failures.map((result) => cleanupCause(result.reason)),
          "mcp-cleanup-causes",
        ),
      });
  }
}
