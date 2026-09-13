/**
 * 功能概述：注册管理端跨会话解析、目标批准、正文查看和确认接口。
 * 主要职责：所有路由先验证 management 凭据，再严格校验输入；动态读取 Runtime，热切换返回 503。
 * 代码库关系：app.ts 注入认证钩子，server.ts 注入 MessageTargetService；本文件不调用平台出口。
 * 输入输出与副作用：批准会写入统一信息链；响应 no-store，错误不反射原始 ID、正文或异常。
 */
import { z } from "@kaguya/schema";
import { targetQuerySchema, type MessageTargetService } from "@kaguya/runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
export function registerMessageTargetRoutes(
  app: FastifyInstance,
  getService: () => MessageTargetService | undefined,
  authenticate: (request: FastifyRequest, reply: FastifyReply) => unknown,
) {
  const id = z.string().min(1).max(512);
  const authorize = z
    .object({
      reference: id,
      sourceTurnContextInformationId: id,
      instruction: z.string().trim().min(1).max(16000),
    })
    .strict();
  const confirm = z
    .object({
      requestId: id,
      assistantInformationId: id,
      text: z.string().min(1).max(131072),
    })
    .strict();
  function post<T>(
    path: string,
    schema: z.ZodType<T>,
    run: (service: MessageTargetService, input: T) => Promise<unknown>,
  ) {
    app.post(
      `/api/v1/message-targets/${path}`,
      {
        onRequest: async (request, reply) => {
          await authenticate(request, reply);
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        const service = getService();
        if (!service)
          return reply.code(503).send({ code: "runtime-unavailable" });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ code: "invalid-target-request" });
        try {
          return await run(service, parsed.data);
        } catch {
          return reply.code(409).send({ code: "target-request-rejected" });
        }
      },
    );
  }
  post("sources", z.object({}).strict(), (s) => s.sources());
  post("resolve", targetQuerySchema, (s, q) => s.resolve(q));
  post("authorize", authorize, (s, q) => s.authorize(q));
  post("status", z.object({ requestId: id }).strict(), (s, q) =>
    s.status(q.requestId),
  );
  post("confirm", confirm, (s, q) =>
    s.confirm(q.requestId, q.assistantInformationId, q.text),
  );
}
