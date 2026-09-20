import type {
  FastifyInstance,
  FastifyReply,
  onRequestHookHandler,
} from "fastify";
import { ModuleTemplateError } from "./module-template-management.js";
import type { IdentityPersonaManagement } from "./identity-persona-management.js";

const identityResourcePaths = {
  name: "/api/v1/identity/name-template",
  aliases: "/api/v1/identity/aliases-template",
  persona: "/api/v1/identity/persona-template",
} as const;

export function registerIdentityPersonaRoutes(
  app: FastifyInstance,
  auth: onRequestHookHandler,
  management?: IdentityPersonaManagement,
) {
  const handle = async (
    operation: () => unknown | Promise<unknown>,
    reply: FastifyReply,
  ) => {
    reply.header("Cache-Control", "no-store");
    try {
      if (!management)
        throw new ModuleTemplateError(503, "template_management_unavailable");
      return { data: await operation() };
    } catch (error) {
      const safe =
        error instanceof ModuleTemplateError
          ? error
          : new ModuleTemplateError(503, "template_operation_failed");
      return reply.code(safe.status).send({
        error: {
          code: safe.code,
          message: "身份模板操作未完成，请重新读取后再试。",
        },
      });
    }
  };
  for (const [kind, url] of Object.entries(identityResourcePaths) as Array<
    [keyof typeof identityResourcePaths, string]
  >) {
    app.get(url, { onRequest: auth }, (_request, reply) =>
      handle(() => management!.get(kind), reply),
    );
    for (const method of ["PUT", "DELETE"] as const)
      app.route({
        method,
        url,
        onRequest: auth,
        handler: (request, reply) =>
          handle(
            () => management!.change(request.body, method === "DELETE", kind),
            reply,
          ),
      });
  }
}
