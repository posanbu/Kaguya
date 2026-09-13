/**
 * 功能概述：独立注册模块配置管理路由，复用宿主 management 认证。
 * 主要职责：GET 投影安全配置，PUT 完整替换；固定错误消息避免透出原始 Zod/文件异常。
 * 代码库关系：app.ts 注入认证钩子与 ModuleSettingsManagement，不依赖 Profile 编辑实现。
 * 输入输出与副作用：所有响应 no-store；仅 PUT 落盘，不启动或重载运行时。
 */
import type { FastifyInstance, onRequestHookHandler } from "fastify";
import {
  ModuleSettingsError,
  type ModuleSettingsManagement,
} from "./module-settings-management.js";
export function registerModuleSettingsRoutes(
  app: FastifyInstance,
  auth: onRequestHookHandler,
  management?: ModuleSettingsManagement,
) {
  const handle = async (
    operation: () => Promise<unknown>,
    reply: import("fastify").FastifyReply,
  ) => {
    reply.header("Cache-Control", "no-store");
    try {
      if (!management)
        throw new ModuleSettingsError(503, "module_management_unavailable");
      return { data: await operation() };
    } catch (error) {
      const safe =
        error instanceof ModuleSettingsError
          ? error
          : new ModuleSettingsError(503, "module_configuration_unavailable");
      return reply
        .code(safe.status)
        .send({
          error: {
            code: safe.code,
            message: "模块配置操作未完成，请检查字段或重新读取配置。",
            fields: safe.fields,
          },
        });
    }
  };
  app.get<{ Params: { definitionId: string } }>(
    "/api/v1/modules/:definitionId/settings",
    { onRequest: auth },
    (request, reply) =>
      handle(() => management!.get(request.params.definitionId), reply),
  );
  app.put<{ Params: { definitionId: string; instanceId: string } }>(
    "/api/v1/modules/:definitionId/instances/:instanceId/settings",
    { onRequest: auth },
    (request, reply) =>
      handle(
        () =>
          management!.replace(
            request.params.definitionId,
            request.params.instanceId,
            request.body,
          ),
        reply,
      ),
  );
}
