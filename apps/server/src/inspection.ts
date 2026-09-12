/**
 * 功能概述：把 Runtime Manifest 与 Ledger 转换为版本化只读 Inspection API，复用 Gateway 认证。
 * 主要职责：createInspectionService 提供模块、游标 Atom 页、详情和以 runtime context 为界的 Flow；
 * registerInspectionRoutes 仅注册 GET，先认证再校验查询，返回稳定错误及 no-store 缓存策略。
 * 代码库关系：由 app.ts 注册，server.ts 注入已启动 Runtime 的 inspectModules 和数据库只读端口；
 * schema 包约束 DTO，inspection-redaction.ts 统一清理所有响应，WebUI 不接触配置或原始数据库对象。
 * 输入输出与副作用：只执行有界读取；游标绑定过滤条件并校验时间/ID；Flow 不递归扩展其他 context，
 * 节点最多 500，边最多 2000，详情引用最多 100，明确报告截断和图外引用；无编辑、重放或订阅。
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { InformationRepository } from "@kaguya/database";
import {
  z,
  inspectionModulesSchema,
  inspectionPageSchema,
  inspectionDetailSchema,
  inspectionFlowSchema,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import { createInspectionRedactor } from "./inspection-redaction.js";

const date = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(512);
const pageQuery = z
  .object({
    kind: z.string().min(1).max(256).optional(),
    source: z.string().min(1).max(256).optional(),
    after: date.optional(),
    before: date.optional(),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (q) => !q.after || !q.before || Date.parse(q.after) < Date.parse(q.before),
  );
const cursorSchema = z
  .object({ occurredAt: date, informationId: id, filter: z.string() })
  .strict();
function parseRequest<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch {
    throw new InspectionError(400, "invalid_inspection_request");
  }
}
const summary = (a: DeepReadonly<InformationAtom>) => ({
  informationId: a.informationId,
  kind: a.kind,
  source: a.source,
  occurredAt: a.occurredAt,
});
export interface InspectionSource {
  readonly ledger: Pick<InformationRepository, "get" | "inspectPage">;
  readonly modules: () => unknown;
  readonly secrets: unknown;
}
export function createInspectionService(source: InspectionSource) {
  const redact = createInspectionRedactor(source.secrets);
  return {
    modules() {
      return inspectionModulesSchema.parse(
        redact({ version: 1, modules: source.modules() }),
      );
    },
    async atoms(input: unknown, contextsOnly = false) {
      const {
        cursor: encoded,
        limit,
        ...filters
      } = parseRequest(pageQuery, input);
      if (contextsOnly) filters.kind = "core.runtime.context";
      const filter = createHash("sha256")
        .update(JSON.stringify(filters))
        .digest("hex");
      let cursor: z.infer<typeof cursorSchema> | undefined;
      if (encoded !== undefined) {
        try {
          cursor = cursorSchema.parse(
            JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
          );
        } catch {
          throw new InspectionError(400, "invalid_cursor");
        }
        if (cursor.filter !== filter)
          throw new InspectionError(400, "invalid_cursor");
      }
      const rows = await source.ledger.inspectPage({
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.source ? { source: filters.source } : {}),
        ...(filters.after ? { after: filters.after } : {}),
        ...(filters.before ? { before: filters.before } : {}),
        limit: limit + 1,
        ...(cursor ? { cursor } : {}),
      });
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                occurredAt: last.occurredAt,
                informationId: last.informationId,
                filter,
              }),
            ).toString("base64url")
          : null;
      // 游标只携带分页定位字段；内容与元数据均经相同脱敏器。
      return inspectionPageSchema.parse({
        version: 1,
        items: redact(items.map(summary)),
        nextCursor,
        truncated: rows.length > limit,
      });
    },
    async detail(informationId: string) {
      const atom = await source.ledger.get(parseRequest(id, informationId));
      if (!atom) throw new InspectionError(404, "atom_not_found");
      const reverse = await source.ledger.inspectPage({
        referencedId: informationId,
        limit: 101,
      });
      return inspectionDetailSchema.parse(
        redact({
          version: 1,
          atom: {
            ...summary(atom),
            payload: atom.payload,
            references: atom.references.slice(0, 100).map((r) => ({
              relation: r.relation,
              informationId: r.informationId,
            })),
          },
          referencedBy: reverse.slice(0, 100).map(summary),
          referencesTruncated: atom.references.length > 100,
          reverseReferencesTruncated: reverse.length > 100,
        }),
      );
    },
    async flow(contextInformationId: string, input: unknown) {
      const flowQuery = z
        .object({ limit: z.coerce.number().int().min(2).max(500).default(200) })
        .strict();
      const { limit } = parseRequest(flowQuery, input);
      const context = await source.ledger.get(
        parseRequest(id, contextInformationId),
      );
      if (!context || context.kind !== "core.runtime.context")
        throw new InspectionError(404, "context_not_found");
      const rows = await source.ledger.inspectPage({
        referencedId: contextInformationId,
        relation: "core:context",
        limit,
      });
      const atoms = [context, ...rows.slice(0, limit - 1)].sort(
        (a, b) =>
          Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
          a.informationId.localeCompare(b.informationId),
      );
      const ids = new Set(atoms.map((a) => a.informationId));
      const edges: { from: string; to: string; relation: string }[] = [];
      let externalReferences = 0;
      let truncated = rows.length >= limit;
      for (const atom of atoms)
        for (const reference of atom.references) {
          if (!ids.has(reference.informationId)) {
            externalReferences++;
            continue;
          }
          if (edges.length >= 2000) {
            truncated = true;
            continue;
          }
          edges.push({
            from: atom.informationId,
            to: reference.informationId,
            relation: reference.relation,
          });
        }
      return inspectionFlowSchema.parse(
        redact({
          version: 1,
          contextInformationId,
          nodes: atoms.map(summary),
          edges,
          truncated,
          externalReferences,
        }),
      );
    },
  };
}
export type InspectionService = ReturnType<typeof createInspectionService>;
class InspectionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function registerInspectionRoutes(
  app: FastifyInstance,
  service: InspectionService | undefined,
  authenticate: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>,
) {
  const routes: [
    string,
    (request: FastifyRequest, service: InspectionService) => unknown,
  ][] = [
    ["modules", (_, s) => s.modules()],
    ["atoms", (r, s) => s.atoms(r.query)],
    [
      "atoms/:informationId",
      (r, s) =>
        s.detail(
          parseRequest(z.object({ informationId: id }), r.params).informationId,
        ),
    ],
    ["flows", (r, s) => s.atoms(r.query, true)],
    [
      "flows/:informationId",
      (r, s) =>
        s.flow(
          parseRequest(z.object({ informationId: id }), r.params).informationId,
          r.query,
        ),
    ],
  ];
  for (const [path, handler] of routes)
    app.get(
      `/api/v1/inspection/${path}`,
      {
        onRequest: async (r, reply) => {
          reply.header("Cache-Control", "no-store");
          return authenticate(r, reply);
        },
        schema: {
          tags: ["Inspection"],
          security: [{ bearerAuth: [] }],
          summary: `Read ${path}`,
        },
      },
      async (request, reply) => {
        try {
          if (!service)
            throw new InspectionError(503, "inspection_unavailable");
          return { data: await handler(request, service) };
        } catch (error) {
          const status = error instanceof InspectionError ? error.status : 500;
          const code =
            error instanceof InspectionError
              ? error.code
              : status === 400
                ? "invalid_inspection_request"
                : "inspection_failed";
          // 驱动异常和未脱敏原子不得进入 HTTP 错误或日志。
          return reply
            .code(status)
            .send({ error: { code, message: code, requestId: request.id } });
        }
      },
    );
}
