/**
 * 功能概述：校验宿主 MCP 连接、协议和权限，不接受模型提供的传输参数。
 * mcpConfigurationSchema 固定三个协议 profile、工具白名单、scope 和预算；
 * loadMcpConfiguration 从敏感配置目录按需读取，缺省关闭且不创建文件。
 * connectionRevision 对完整可信配置生成摘要；凭据只以环境变量引用表示，执行时解析。
 * Server 和 McpHost 共用此边界；cleanupCause仅保留内部代码及脱敏阶段，不保留命令、环境或凭据。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { readSensitiveJson } from "@kaguya/config";
import { z } from "@kaguya/schema";

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const reference = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const header = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
  .refine(
    (value) =>
      !/^(?:mcp-|content-|accept$|host$|origin$|cookie$|set-cookie$|connection$|transfer-encoding$)/i.test(
        value,
      ),
  );
export const mcpProtocolSchema = z.enum([
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);
const policy = z
  .object({
    name: z.string().min(1).max(128),
    readonly: z.boolean().default(false),
    independent: z.boolean().default(false),
  })
  .strict()
  .refine((value) => !value.independent || value.readonly);
const transport = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).max(128).default([]),
      cwd: z.string().min(1).optional(),
      envRefs: z.record(reference, reference).default({}),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.hash &&
          !url.search &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
        );
      }),
      headerRefs: z.record(header, reference).default({}),
    })
    .strict(),
]);
export const mcpConnectionSchema = z
  .object({
    id: identity,
    revision: identity,
    enabled: z.boolean().default(false),
    protocol: mcpProtocolSchema,
    transport,
    scopes: z.array(z.string().min(1)).min(1).max(128),
    tools: z.array(policy).max(256).default([]),
    resourceUriPrefixes: z.array(z.string().min(1)).max(128).default([]),
    prompts: z.array(z.string().min(1)).max(128).default([]),
    timeoutMs: z.number().int().min(100).max(300000).default(30000),
    maxPages: z.number().int().min(1).max(64).default(16),
    maxItems: z.number().int().min(1).max(4096).default(256),
    maxBytes: z.number().int().min(256).max(10485760).default(1048576),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.tools.map((tool) => tool.name)).size !== value.tools.length
    )
      context.addIssue({
        code: "custom",
        message: "duplicate MCP tool policy",
      });
  });
export const mcpConfigurationSchema = z
  .object({
    version: z.literal(1),
    connections: z.array(mcpConnectionSchema).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.connections.map((connection) => connection.id)).size !==
      value.connections.length
    )
      context.addIssue({ code: "custom", message: "duplicate MCP connection" });
  });
export type McpConnectionConfig = z.infer<typeof mcpConnectionSchema>;
export type McpConfiguration = z.infer<typeof mcpConfigurationSchema>;
export class McpError extends Error {
  readonly details:
    Readonly<Record<string, string | number | boolean | null>> | undefined;
  constructor(
    readonly code: string,
    options: {
      cause?: unknown;
      details?: Readonly<Record<string, string | number | boolean | null>>;
    } = {},
  ) {
    super(
      code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    if (options.details) this.details = options.details;
    this.name = "McpError";
  }
}
/** 只传播可信内部错误的结构；execFile等外部Error的message/stdout/stderr/stack不进入cause。 */
export function cleanupCause(error: unknown, depth = 0): Error {
  if (depth >= 12) return new McpError("mcp-cleanup-cause-truncated");
  if (error instanceof AggregateError)
    return new AggregateError(
      error.errors.slice(0, 65).map((value) => cleanupCause(value, depth + 1)),
      "mcp-cleanup-causes",
    );
  if (error instanceof McpError && /^mcp-[a-z0-9-]+$/.test(error.code))
    return new McpError(error.code, {
      ...(error.details ? { details: error.details } : {}),
      ...(error.cause === undefined
        ? {}
        : { cause: cleanupCause(error.cause, depth + 1) }),
    });
  const errno =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return new McpError("mcp-cleanup-system-error", {
    details: {
      errno: [
        "ESRCH",
        "EPERM",
        "EACCES",
        "EIO",
        "ENOENT",
        "ETIMEDOUT",
        "ENOBUFS",
      ].includes(errno)
        ? errno
        : "UNKNOWN",
    },
  });
}
export function digest(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function connectionRevision(config: McpConnectionConfig) {
  return digest(config);
}
export async function loadMcpConfiguration(
  root: string,
): Promise<McpConfiguration> {
  try {
    await lstat(join(root, "mcp.json"));
    const raw = await readSensitiveJson(join(root, "mcp.json"));
    const parsed = mcpConfigurationSchema.safeParse(raw);
    if (!parsed.success) throw new McpError("mcp-configuration-invalid");
    return parsed.data;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { version: 1, connections: [] };
    throw new McpError("mcp-configuration-invalid");
  }
}
