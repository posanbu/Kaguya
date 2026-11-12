/**
 * 功能概述：Linux GUI 的管理 HTTP 边界，复用 Gateway management 认证与已有 LinuxToolsHost。
 * 主要职责：严格校验独立 GUI 任务的提交/查询/取消，复用 GuiTaskService 持久执行；注册状态、双向接管、人工观察/输入/核对、续期/关闭及原图读取；scope 从宿主配置取得。
 * 代码库关系：mcp-host.ts 随现有 HTTP 生命周期注册，宿主 client 持有会话秘密，broker 负责持久身份及排空。
 * 输入输出与副作用：浏览器只持公开 sessionId/generation；写请求严格校验，回执丢失只查询原 operation。
 * 图像路由要求同样 Bearer 认证并设置 no-store，不提供 URL 凭证；错误不回显参数或内部异常。
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "@kaguya/schema";
import {
  guiTaskInputSchema,
  type GuiTaskService,
  type LinuxToolsHost,
} from "@kaguya/runtime";
import type { GatewayAuthenticator } from "./gateway-auth.js";

const id = z.string().min(1).max(200);
const paramsSchema = z.object({ environmentId: id }).strict();
const session = {
  generation: z.number().int().nonnegative(),
  sessionId: z.string().regex(/^[a-f0-9]{64}$/),
};
const controlSchema = z
  .object({
    generation: session.generation,
    controlAuthorizationId: z.string().uuid(),
  })
  .strict();
const sessionSchema = z.object(session).strict();
const operationSchema = z
  .object({
    ...session,
    operationId: z.string().uuid(),
    arguments: z.unknown(),
  })
  .strict();

export function registerLinuxEnvironmentRoutes(
  app: FastifyInstance,
  getHost: () => LinuxToolsHost | undefined,
  auth: GatewayAuthenticator,
  getGuiTasks?: () => GuiTaskService | undefined,
) {
  const options = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store");
      const token =
        /^Bearer[ \t]+(.+)$/i.exec(request.headers.authorization ?? "")?.[1] ??
        "";
      if (!(await auth.authorize(token, "management")))
        return reply.code(401).send({ error: "unauthorized" });
    },
  };
  const prefix = "/api/v1/environments/:environmentId";
  const taskParams = paramsSchema
    .extend({ taskRequestId: z.string().uuid() })
    .strict();
  const taskError = (reply: FastifyReply, error: unknown) => {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "gui-task-not-found")
      return reply.code(404).send({ error: reason });
    const publicReasons = [
      "gui-task-id-conflict",
      "gui-task-unavailable",
      "gui-environment-unavailable",
      "gui-observation-required",
    ];
    return reply.code(409).send({
      error: publicReasons.includes(reason) ? reason : "gui-task-unconfirmed",
    });
  };
  app.post(`${prefix}/tasks`, options, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params),
      input = guiTaskInputSchema.safeParse(request.body);
    if (!params.success || !input.success)
      return reply.code(400).send({ error: "gui-task-request-invalid" });
    const service = getGuiTasks?.();
    if (!service)
      return reply.code(503).send({ error: "gui-task-unavailable" });
    try {
      return reply
        .code(202)
        .send(await service.submit(params.data.environmentId, input.data));
    } catch (error) {
      return taskError(reply, error);
    }
  });
  app.get(`${prefix}/tasks/:taskRequestId`, options, async (request, reply) => {
    const params = taskParams.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "gui-task-request-invalid" });
    const service = getGuiTasks?.();
    if (!service)
      return reply.code(503).send({ error: "gui-task-unavailable" });
    try {
      return await service.read(
        params.data.environmentId,
        params.data.taskRequestId,
      );
    } catch (error) {
      return taskError(reply, error);
    }
  });
  app.post(
    `${prefix}/tasks/:taskRequestId/cancel`,
    options,
    async (request, reply) => {
      const params = taskParams.safeParse(request.params);
      if (
        !params.success ||
        !z
          .object({})
          .strict()
          .safeParse(request.body ?? {}).success
      )
        return reply.code(400).send({ error: "gui-task-request-invalid" });
      const service = getGuiTasks?.();
      if (!service)
        return reply.code(503).send({ error: "gui-task-unavailable" });
      try {
        return await service.cancel(
          params.data.environmentId,
          params.data.taskRequestId,
        );
      } catch (error) {
        return taskError(reply, error);
      }
    },
  );
  app.get("/api/v1/environments", options, async (_request, reply) => {
    const host = getHost();
    if (!host)
      return reply.code(503).send({ error: "linux-environments-unavailable" });
    try {
      return {
        environments: await Promise.all(
          host.configuration.bindings
            .filter((binding) => binding.gui)
            .map((binding) => host.inspect(binding.environmentId)),
        ),
      };
    } catch {
      return reply.code(409).send({ error: "linux-environment-unconfirmed" });
    }
  });
  app.get(`${prefix}/control`, options, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success)
      return reply
        .code(400)
        .send({ error: "linux-environment-request-invalid" });
    try {
      const host = getHost();
      if (!host)
        return reply
          .code(503)
          .send({ error: "linux-environments-unavailable" });
      return await host.inspect(params.data.environmentId);
    } catch {
      return reply.code(409).send({ error: "linux-environment-unconfirmed" });
    }
  });
  for (const action of [
    "handoff",
    "resume",
    "human/renew",
    "human/close",
    "human/observe",
    "human/input",
    "human/verify",
  ] as const) {
    app.post(`${prefix}/${action}`, options, async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const control = action === "handoff" || action === "resume";
      const operation = [
        "human/observe",
        "human/input",
        "human/verify",
      ].includes(action);
      const body = (
        control ? controlSchema : operation ? operationSchema : sessionSchema
      ).safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .code(400)
          .send({ error: "linux-environment-request-invalid" });
      const host = getHost();
      if (!host)
        return reply
          .code(503)
          .send({ error: "linux-environments-unavailable" });
      try {
        const environmentId = params.data.environmentId;
        if (control) {
          const value = controlSchema.parse(body.data);
          return await host[action](
            environmentId,
            value.generation,
            value.controlAuthorizationId,
          );
        }
        if (operation) {
          const value = operationSchema.parse(body.data);
          return await host.operateHuman({
            environmentId,
            ...value,
            toolName:
              action === "human/observe"
                ? "gui.observe"
                : action === "human/input"
                  ? "gui.act"
                  : "gui.verify",
          });
        }
        const value = { environmentId, ...sessionSchema.parse(body.data) };
        return await (action === "human/renew"
          ? host.renewHuman(value)
          : host.closeHuman(value));
      } catch {
        return reply.code(409).send({ error: "linux-environment-unconfirmed" });
      }
    });
  }
  app.get(
    `${prefix}/human/operations/:operationId`,
    options,
    async (request, reply) => {
      const params = z
        .object({ environmentId: id, operationId: z.string().uuid() })
        .strict()
        .safeParse(request.params);
      if (!params.success)
        return reply
          .code(400)
          .send({ error: "linux-environment-request-invalid" });
      const host = getHost();
      if (!host)
        return reply
          .code(503)
          .send({ error: "linux-environments-unavailable" });
      try {
        return await host.queryHuman(
          params.data.environmentId,
          params.data.operationId,
        );
      } catch {
        return reply.code(409).send({ error: "linux-environment-unconfirmed" });
      }
    },
  );
  app.get(`${prefix}/images/:artifactId`, options, async (request, reply) => {
    const params = z
      .object({ environmentId: id, artifactId: id })
      .strict()
      .safeParse(request.params);
    if (!params.success)
      return reply
        .code(400)
        .send({ error: "linux-environment-request-invalid" });
    const host = getHost();
    if (!host)
      return reply.code(503).send({ error: "linux-environments-unavailable" });
    try {
      const raw = z
        .object({
          artifact: z.object({
            mime: z.literal("image/png"),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          }),
          dataBase64: z.string().max(24 * 1024 * 1024),
        })
        .parse(
          await host.readGuiArtifact(
            params.data.environmentId,
            params.data.artifactId,
          ),
        );
      const bytes = Buffer.from(raw.dataBase64, "base64");
      if (
        bytes.length < 24 ||
        bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        createHash("sha256").update(bytes).digest("hex") !== raw.artifact.hash
      )
        throw new Error("gui-image-integrity");
      return reply
        .type("image/png")
        .header("X-Content-Type-Options", "nosniff")
        .send(bytes);
    } catch {
      return reply.code(409).send({ error: "linux-image-unavailable" });
    }
  });
}
