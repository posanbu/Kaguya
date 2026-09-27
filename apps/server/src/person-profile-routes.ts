/** 人物画像的独立管理接口；Inspection 继续只读。 */
import type {
  FastifyInstance,
  FastifyReply,
  onRequestHookHandler,
} from "fastify";
import { PersonProfileStoreError } from "@kaguya/database";
import type { PersonProfileManagement } from "./person-profile-management.js";

export function registerPersonProfileRoutes(
  app: FastifyInstance,
  auth: onRequestHookHandler,
  management?: PersonProfileManagement,
) {
  const url = "/api/v1/people/:personInformationId/profile";
  const handle = async (
    operation: () => Promise<unknown>,
    reply: FastifyReply,
  ) => {
    reply.header("Cache-Control", "no-store");
    try {
      if (!management)
        return reply.code(503).send({ error: { code: "profile_unavailable" } });
      return { data: await operation() };
    } catch (error) {
      if (error instanceof PersonProfileStoreError)
        return reply.code(error.status).send({ error: { code: error.code } });
      return reply.code(503).send({ error: { code: "profile_unavailable" } });
    }
  };
  app.get<{ Params: { personInformationId: string } }>(
    url,
    { onRequest: auth },
    (request, reply) =>
      handle(() => management!.get(request.params.personInformationId), reply),
  );
  app.put<{ Params: { personInformationId: string } }>(
    url,
    { onRequest: auth },
    (request, reply) =>
      handle(
        () =>
          management!.save(request.params.personInformationId, request.body),
        reply,
      ),
  );
  app.post<{ Params: { personInformationId: string } }>(
    `${url}/preview`,
    { onRequest: auth },
    (request, reply) =>
      handle(
        () =>
          management!.preview(request.params.personInformationId, request.body),
        reply,
      ),
  );
}
