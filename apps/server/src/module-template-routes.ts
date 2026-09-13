/**
 * 功能概述：模板源码管理路由，仅供受认证管理端读取和写入本地覆盖。
 * 主要职责：GET 返回静态契约；PUT 保存，DELETE 恢复默认；错误仅返回稳定校验代码。
 * 代码库关系：app.ts 注入 management 认证与模板管理器，复用既有请求边界。
 * 输入输出与副作用：所有响应 no-store；无日志正文、渲染预览或运行时数据读取。
 */
import type {
  FastifyInstance,
  onRequestHookHandler,
  FastifyReply,
} from "fastify";
import {
  ModuleTemplateError,
  type ModuleTemplateManagement,
} from "./module-template-management.js";
export function registerModuleTemplateRoutes(
  app: FastifyInstance,
  auth: onRequestHookHandler,
  management?: ModuleTemplateManagement,
) {
  const handle = async (
    op: () => unknown | Promise<unknown>,
    reply: FastifyReply,
  ) => {
    reply.header("Cache-Control", "no-store");
    try {
      if (!management)
        throw new ModuleTemplateError(503, "template_management_unavailable");
      return { data: await op() };
    } catch (error) {
      const safe =
        error instanceof ModuleTemplateError
          ? error
          : new ModuleTemplateError(503, "template_operation_failed");
      return reply
        .code(safe.status)
        .send({
          error: {
            code: safe.code,
            message: "模板操作未完成，请检查模板或重新读取。",
          },
        });
    }
  };
  app.get<{ Params: { definitionId: string } }>(
    "/api/v1/modules/:definitionId/templates",
    { onRequest: auth },
    (request, reply) =>
      handle(() => management!.get(request.params.definitionId), reply),
  );
  for (const method of ["PUT", "DELETE"] as const)
    app.route<{ Params: { definitionId: string; templateId: string } }>({
      method,
      url: "/api/v1/modules/:definitionId/templates/:templateId",
      onRequest: auth,
      handler: (request, reply) =>
        handle(
          () =>
            management!.change(
              request.params.definitionId,
              request.params.templateId,
              request.body,
              method === "DELETE",
            ),
          reply,
        ),
    });
}
