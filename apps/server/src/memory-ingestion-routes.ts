/**
 * 功能概述：提供主动记忆录入的管理 API，先鉴权再读取或写入。
 * 主要职责：records 列出全局已录入断言，mutate 执行可撤销删除；jobs 接收并返回持久排队凭据；session 读取进度；retry 复用原任务。
 * 代码库关系：app.ts 复用 management Token 注册，动态 service 在 Memory/knowledge 未启用时明确返回 503。
 * 输入输出与副作用：响应不缓存，不回显模型异常、凭据或计划；202 只表示接受，不表示已经入库。
 */
import type {
  FastifyInstance,
  FastifyReply,
  onRequestHookHandler,
} from "fastify";
import { MemoryIngestionError } from "@kaguya/database";
import { z } from "@kaguya/schema";
import type { MemoryIngestionService } from "./memory-ingestion.js";

export function registerMemoryIngestionRoutes(
  app: FastifyInstance,
  auth: onRequestHookHandler,
  service?: MemoryIngestionService,
) {
  const run = async (
    reply: FastifyReply,
    operation: () => Promise<unknown>,
  ) => {
    reply.header("Cache-Control", "no-store");
    try {
      return { data: await operation() };
    } catch (error) {
      const safe =
        error instanceof MemoryIngestionError
          ? error
          : new MemoryIngestionError("ingestion_operation_failed", 503);
      return reply.code(safe.status).send({
        error: {
          code: safe.code,
          message: "记忆录入未完成，请检查当前状态后重试。",
        },
      });
    }
  };
  const store = () => {
    if (!service) throw new MemoryIngestionError("ingestion_unavailable", 503);
    return service.available();
  };
  const uuid = (value: unknown) => {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new MemoryIngestionError("invalid_request_id");
    return parsed.data;
  };
  app.get<{ Querystring: { query?: string; offset?: string } }>(
    "/api/v1/memory-ingestion/records",
    { onRequest: auth },
    (request, reply) =>
      run(reply, async () => {
        const parsed = z
          .object({
            query: z.string().max(200).default(""),
            offset: z.coerce.number().int().min(0).max(100000).default(0),
          })
          .strict()
          .safeParse(request.query);
        if (!parsed.success)
          throw new MemoryIngestionError("invalid_record_query");
        return store().records(parsed.data.query, parsed.data.offset);
      }),
  );
  app.post(
    "/api/v1/memory-ingestion/records/mutate",
    { onRequest: auth },
    (request, reply) => run(reply, () => store().mutateRecord(request.body)),
  );
  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/memory-ingestion/sessions/:sessionId",
    {
      onRequest: auth,
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    (request, reply) =>
      run(reply, async () => ({
        jobs: await store().list(uuid(request.params.sessionId)),
      })),
  );
  app.post(
    "/api/v1/memory-ingestion/jobs",
    { onRequest: auth },
    (request, reply) =>
      run(reply, async () => {
        const job = await store().submit(request.body);
        reply.code(
          job.status === "queued" || job.status === "processing" ? 202 : 200,
        );
        void service!.kick();
        return job;
      }),
  );
  app.post<{ Params: { requestId: string } }>(
    "/api/v1/memory-ingestion/jobs/:requestId/retry",
    { onRequest: auth },
    (request, reply) =>
      run(reply, async () => {
        const job = await store().retry(uuid(request.params.requestId));
        void service!.kick();
        return job;
      }),
  );
}
