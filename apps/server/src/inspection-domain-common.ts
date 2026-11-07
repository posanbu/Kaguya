/**
 * 功能概述：领域 Inspection 共用的参数、签名游标、内容清理和引用校验边界。
 * DomainReader 在只读快照中运行投影，游标绑定路由/范围/过滤与上界；safe 限制正文大小并移除
 * prompt、私有路径、凭据和图像数据。reference 不把存在的任意 ID 当作跨 scope 读取许可。
 * 代码库关系：inspection-domain 组合各领域服务，inspection.ts 复用管理认证和安全错误码。
 * 输入输出与副作用：仅数据库读取；游标签名键只在服务闭包内，不持久化新业务状态。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z, type JsonValue } from "@kaguya/schema";
import {
  withInspectionRead,
  type KaguyaDatabase,
  type InspectionReader,
  type InspectionBoundary,
  type InspectionFact,
} from "@kaguya/database";
import { createInspectionRedactor } from "./inspection-redaction.js";

export class InspectionDomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export const denied = () =>
  new InspectionDomainError(404, "inspection_not_found_or_denied");
export const identifier = z.string().min(1).max(1000);
export const querySchema = z
  .object({
    scope: identifier,
    consumerId: identifier.optional(),
    cursor: z.string().min(1).max(8192).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export function parse<T>(schema: { parse(v: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new InspectionDomainError(400, "invalid_inspection_request");
  }
}
export const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
export const text = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
export const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
/** One transaction owns one pg client; do not queue concurrent client.query calls. */
export async function serialMap<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];
  for (const item of items) result.push(await fn(item));
  return result;
}
export function addressScope(address: any): string | null {
  const a = object(address),
    d = object(a.destination);
  return typeof a.platform === "string" &&
    typeof a.adapterId === "string" &&
    typeof d.kind === "string"
    ? JSON.stringify([
        a.platform,
        a.adapterId,
        d.kind,
        d.userId ?? d.groupId ?? d.conversationId ?? null,
      ])
    : null;
}
export function factScope(fact: InspectionFact): string | null {
  const p = fact.payload;
  return (
    text(p.scope) ??
    text(p.scopeKey) ??
    text(p.spec?.scope) ??
    text(p.intent?.scope) ??
    text(p.memorySource?.scope) ??
    addressScope(p.source)
  );
}
export const hasReference = (
  fact: InspectionFact | undefined,
  id: string,
  relation: string,
) =>
  Boolean(
    fact?.references.some(
      (r) => r.informationId === id && r.relation === relation,
    ),
  );
/** Scope-free framework facts need a persisted domain binding; their IDs alone never authorize reading. */
export async function permittedFact(
  r: InspectionReader,
  f: InspectionFact,
  scope: string,
  depth = 0,
): Promise<boolean> {
  const direct = factScope(f);
  if (direct !== null) return direct === scope;
  if (depth > 3) return false;
  if (
    (
      await r.rows(
        "SELECT 1 FROM information_action_runs WHERE run_id=$1 AND scope=$2",
        [f.id, scope],
      )
    ).length
  )
    return true;
  if (
    f.kind.startsWith("core.action.") &&
    typeof f.payload.intentId === "string"
  )
    return Boolean(await r.action(f.payload.intentId, scope));
  if (f.kind === "agent.action.decision.v1")
    return Boolean(
      (
        await r.rows(
          "SELECT 1 FROM information_action_heads WHERE input->>'scope'=$1 AND input->>'decisionInformationId'=$2 LIMIT 1",
          [scope, f.id],
        )
      ).length,
    );
  if (
    f.kind.startsWith("agent.heavy.tool.") &&
    typeof f.payload.runInformationId === "string"
  ) {
    const run = await r.run(f.payload.runInformationId, scope);
    if (!run) return false;
    return (
      run.stopped_id === f.id ||
      (await r.steps(run.run_id)).some((s) => s.frozen_id === f.id) ||
      (await r.calls(run.run_id)).some((c) => c.result_id === f.id)
    );
  }
  if (f.kind === "core.model.task.requested") {
    const step = f.payload.nativeStep;
    if (!step || !(await r.run(step.runInformationId, scope))) return false;
    return (await r.steps(step.runInformationId)).some(
      (s) =>
        s.request_id === f.id &&
        s.step_index === step.stepIndex &&
        hasReference(f, s.frozen_id, "core:uses-context"),
    );
  }
  if (f.kind.startsWith("core.model.task.")) {
    const relation =
      f.kind === "core.model.task.dispatched.v1"
        ? "core:caused-by"
        : "core:status-of";
    const refs = f.references.filter((x) => x.relation === relation);
    if (refs.length !== 1) return false;
    const request = await r.fact(refs[0]!.informationId);
    return Boolean(
      request?.kind === "core.model.task.requested" &&
      (await permittedFact(r, request, scope, depth + 1)),
    );
  }
  return false;
}
export async function reference(
  reader: InspectionReader,
  scope: string,
  id: string,
  relation: string,
  domain:
    | "atom"
    | "observation"
    | "run"
    | "action"
    | "memory"
    | "gui-task"
    | "environment" = "atom",
) {
  const f = await reader.fact(id);
  return {
    domain,
    id,
    relation,
    availability:
      f && (await permittedFact(reader, f, scope))
        ? ("available" as const)
        : ("missing-or-denied" as const),
  };
}
export function safeContent(
  redact: (v: unknown) => JsonValue,
  input: unknown,
  provedMemory = false,
) {
  const omitted = new Set<string>();
  let remaining = 64_000,
    truncated = false;
  const visit = (v: unknown, depth: number): JsonValue => {
    if (depth > 16 || remaining <= 0) {
      truncated = true;
      return null;
    }
    remaining -= 8;
    if (typeof v === "string") {
      const cleaned = (redact(v) as string)
        .replace(/data:[^\s"']+/gi, "[IMAGE DATA OMITTED]")
        .replace(
          /(?:file:\/\/[^\s"']+|\/(?:Users|home|root|run|tmp|var|private|etc|opt)\/[^\s"']+|[A-Z]:\\[^\s"']+)/gi,
          "[PRIVATE PATH OMITTED]",
        );
      if (cleaned !== v) omitted.add("private-location-or-image-data");
      const max = Math.max(0, Math.min(remaining, 8000));
      if (cleaned.length > max) truncated = true;
      const result = cleaned.slice(0, max);
      remaining -= Buffer.byteLength(result);
      return result;
    }
    if (Array.isArray(v)) {
      if (v.length > 100) truncated = true;
      return v.slice(0, 100).map((x) => visit(x, depth + 1));
    }
    if (v && typeof v === "object") {
      // Frozen bundles preserve the historical IDs/cutoff. Read node text only through the proof-aware history endpoint.
      if (!provedMemory && object(v).metadata?.system === "native-v1") {
        omitted.add("memory-node-content:use-history");
        return visit(
          { nodeId: object(v).id, revision: object(v).metadata.revision },
          depth + 1,
        );
      }
      const entries = Object.entries(v);
      if (entries.length > 100) truncated = true;
      return Object.fromEntries(
        entries.slice(0, 100).flatMap(([key, value]) => {
          if (key === "pendingEvidence" && Array.isArray(value)) {
            omitted.add("memory-pending-evidence-text:use-source");
            if (value.length > 100) truncated = true;
            return [
              [
                key,
                visit(
                  value.slice(0, 100).map((item) => ({
                    informationId: object(item).informationId,
                    occurredAt: object(item).occurredAt,
                  })),
                  depth + 1,
                ),
              ],
            ];
          }
          if (
            /^(prompt|rootPrompt|messages|native|variables|templates|bindings|token|leaseCredential|dataBase64|dataUrl|fullCID|containerId|cid|kernel|isolationEvidence|mounts|cgroup|path|privatePath|socketPath|command|argv|environmentVariables)$/i.test(
              key,
            )
          ) {
            omitted.add(key);
            return [];
          }
          const safeKey = visit(key, depth + 1) as string;
          return [[safeKey, visit(value, depth + 1)]];
        }),
      );
    }
    return v === null || typeof v === "number" || typeof v === "boolean"
      ? v
      : null;
  };
  return { value: redact(visit(input, 0)), omitted: [...omitted], truncated };
}
const cursorSchema = z
  .object({
    binding: z.string(),
    boundary: z.object({
      position: z.string().regex(/^\d+$/),
      recordedAt: z.string(),
    }),
    before: z.string(),
    directoryStamp: z.string().optional(),
  })
  .strict();
export class DomainReader {
  private readonly key = randomBytes(32);
  private readonly redact: (v: unknown) => JsonValue;
  readonly safe: (v: unknown) => ReturnType<typeof safeContent>;
  readonly safeProvedMemory: (v: unknown) => ReturnType<typeof safeContent>;
  constructor(
    readonly database: KaguyaDatabase | undefined,
    secrets: unknown,
  ) {
    const redact = createInspectionRedactor(secrets);
    this.redact = redact;
    this.safe = (v) => safeContent(redact, v);
    this.safeProvedMemory = (v) => safeContent(redact, v, true);
  }
  finish<T>(value: T): T {
    return this.redact(value) as T;
  }
  async read<T>(
    input: unknown,
    binding: string,
    fn: (
      r: InspectionReader,
      q: z.infer<typeof querySchema>,
      meta: {
        version: 1;
        scope: string;
        boundary: InspectionBoundary;
        stateReadAt: string;
        directory?: { limit: number; truncated: boolean };
      },
      before: string | null,
      cursor: (before: string) => string,
    ) => Promise<T>,
  ) {
    if (!this.database)
      throw new InspectionDomainError(503, "inspection_unavailable");
    const q = parse(querySchema, input);
    if (
      binding === "observations" ||
      binding === "progress" ||
      binding.startsWith("observation:")
    ) {
      try {
        const value = z
          .tuple([identifier, identifier, identifier, identifier.nullable()])
          .parse(JSON.parse(q.scope));
        if (JSON.stringify(value) !== q.scope) throw new Error();
      } catch {
        throw new InspectionDomainError(400, "invalid_inspection_request");
      }
    }
    const filter = JSON.stringify([binding, q.scope, q.consumerId ?? null]);
    let saved: z.infer<typeof cursorSchema> | undefined;
    if (q.cursor) {
      try {
        const [body, signature, ...extra] = q.cursor.split(".");
        if (!body || !signature || extra.length) throw new Error();
        const actual = Buffer.from(signature, "base64url");
        const expected = createHmac("sha256", this.key).update(body).digest();
        if (
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        )
          throw new Error();
        saved = cursorSchema.parse(
          JSON.parse(Buffer.from(body, "base64url").toString()),
        );
        if (saved.binding !== filter) throw new Error();
      } catch {
        throw new InspectionDomainError(400, "invalid_cursor");
      }
    }
    return withInspectionRead(
      this.database.sql,
      async (r) => {
        // Sequence/timestamps can be allocated before commit. Reject changed membership, including late commits below the saved upper bound.
        const directory = await r.directory(
          binding,
          q.scope,
          q.consumerId ?? null,
        );
        const directoryStamp = directory?.stamp;
        if (saved && saved.directoryStamp !== directoryStamp)
          throw new InspectionDomainError(409, "inspection_directory_changed");
        const cursor = (before: string) => {
          const body = Buffer.from(
            JSON.stringify({
              binding: filter,
              boundary: r.boundary,
              before,
              directoryStamp,
            }),
          ).toString("base64url");
          return (
            body +
            "." +
            createHmac("sha256", this.key).update(body).digest("base64url")
          );
        };
        return this.finish(
          await fn(
            r,
            q,
            {
              version: 1,
              scope: q.scope,
              boundary: r.boundary,
              stateReadAt: new Date().toISOString(),
              ...(directory
                ? { directory: { limit: 500, truncated: directory.truncated } }
                : {}),
            },
            saved?.before ?? null,
            cursor,
          ),
        );
      },
      saved?.boundary,
    ).catch((error: unknown) => {
      if (
        error instanceof Error &&
        [
          "inspection-memory-dependency-budget",
          "memory-source-closure-budget",
        ].includes(error.message)
      )
        throw new InspectionDomainError(
          409,
          "inspection_dependency_budget_exceeded",
        );
      throw error;
    });
  }
}
