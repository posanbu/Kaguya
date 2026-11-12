/**
 * 功能概述：提供受 Gateway 管理认证保护的 Memory 图检视及手动节点／边管理接口。
 * 主要职责：复用共享 schema 校验输入，编辑执行原子更新；数据库不可用、无效输入及悬空边映射为明确状态码。
 * 代码库关系：app.ts 注册路由，server.ts 动态提供当前 database.memoryGraph，支持数据库重挂载。
 * 输入输出与副作用：GET 返回有界一致快照；POST/PUT/DELETE 直接持久化，不触发模型请求。
 */
import type {
  FastifyInstance,
  FastifyReply,
  onRequestHookHandler,
} from "fastify";
import type { PostgresMemoryGraphStore } from "@kaguya/database";
import { NativeMemoryError } from "@kaguya/database";
import {
  memoryNodeIdSchema,
  memoryGraphQuerySchema,
  memoryPublicationSchema,
  z,
} from "@kaguya/schema";

class GraphRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function registerMemoryGraphRoutes(
  app: FastifyInstance,
  auth: onRequestHookHandler,
  getStore: () => PostgresMemoryGraphStore | undefined,
): void {
  const handle = async (
    reply: FastifyReply,
    operation: (store: PostgresMemoryGraphStore) => Promise<unknown>,
  ) => {
    reply.header("Cache-Control", "no-store");
    const store = getStore();
    if (!store)
      return reply.code(503).send({ error: { code: "memory_unavailable" } });
    try {
      return { data: await operation(store) };
    } catch (error) {
      if (error instanceof NativeMemoryError)
        return reply.code(error.status).send({ error: { code: error.code } });
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      )
        return reply
          .code(409)
          .send({ error: { code: "memory_summary_conflict" } });
      if (error instanceof z.ZodError)
        return reply
          .code(400)
          .send({ error: { code: "invalid_memory_input" } });
      if (error instanceof GraphRequestError)
        return reply.code(error.status).send({ error: { code: error.code } });
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23503"
      )
        return reply
          .code(409)
          .send({ error: { code: "memory_endpoint_missing" } });
      return reply
        .code(500)
        .send({ error: { code: "memory_operation_failed" } });
    }
  };
  const root = "/api/v1/memory";
  app.get(`${root}/status`, { onRequest: auth }, (_request, reply) =>
    handle(reply, (store) => store.native.status()),
  );
  app.post<{ Params: { id: string } }>(
    `${root}/batches/:id/retry`,
    { onRequest: auth },
    (request, reply) =>
      handle(reply, (store) =>
        store.native.retry(memoryNodeIdSchema.parse(request.params.id)),
      ),
  );
  app.post(`${root}/publications`, { onRequest: auth }, (request, reply) =>
    handle(reply, (store) => {
      const input = memoryPublicationSchema.parse(request.body);
      return store.native.publish({ ...input, actor: "manual" });
    }),
  );
  app.get<{ Params: { id: string } }>(
    `${root}/nodes/:id/history-page`,
    { onRequest: auth },
    (request, reply) =>
      handle(reply, (store) => {
        const q = z
          .object({
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.string().max(2000).optional(),
          })
          .strict()
          .parse(request.query);
        return store.native.historyPage(
          memoryNodeIdSchema.parse(request.params.id),
          q,
        );
      }),
  );
  app.get<{ Params: { id: string } }>(
    `${root}/nodes/:id/history`,
    { onRequest: auth },
    (request, reply) =>
      handle(reply, (store) =>
        store.native.history(memoryNodeIdSchema.parse(request.params.id)),
      ),
  );
  app.get<{ Querystring: Record<string, unknown> }>(
    `${root}/graph`,
    { onRequest: auth },
    (request, reply) =>
      handle(reply, (store) => {
        const { tags, limit, level, ...rest } = request.query;
        return store.readGraph(
          memoryGraphQuerySchema.parse({
            ...rest,
            system: "native-v1",
            ...(level === undefined ? {} : { level: Number(level) }),
            ...(tags === undefined
              ? {}
              : { tags: Array.isArray(tags) ? tags : [tags] }),
            ...(limit === undefined
              ? {}
              : { limit: typeof limit === "string" ? Number(limit) : limit }),
          }),
        );
      }),
  );
  app.get<{ Params: { id: string } }>(
    `${root}/nodes/:id`,
    { onRequest: auth },
    (request, reply) =>
      handle(reply, async (store) => {
        const node = await store.getNode(request.params.id);
        if (!node || node.metadata.system !== "native-v1")
          throw new GraphRequestError(404, "memory_node_not_found");
        return node;
      }),
  );
}
