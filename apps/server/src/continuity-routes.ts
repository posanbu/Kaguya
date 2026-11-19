/** 沿用管理认证检视持续活动，并以操作 ID 和版本控制暂停、恢复及放弃。 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  z,
  continuityViewSchema,
  personContinuitySchema,
} from "@kaguya/schema";
import type { KaguyaDatabase } from "@kaguya/database";
import type { GatewayAuthenticator } from "./gateway-auth.js";

const scopeSchema = z.object({ scope: z.string().min(1).max(1000) }).strict();
const controlSchema = scopeSchema
  .extend({
    operationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    action: z.enum(["pause", "resume", "abandon"]),
  })
  .strict();
export function registerContinuityRoutes(
  app: FastifyInstance,
  getDatabase: () => KaguyaDatabase | undefined,
  auth: GatewayAuthenticator,
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
  app.get("/api/v1/continuity", options, async (request, reply) => {
    const query = z
      .object({ scope: z.string().min(1).max(1000).optional() })
      .strict()
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid-scope" });
    const db = getDatabase();
    if (!db) return reply.code(503).send({ error: "database-unavailable" });
    const scopes = await db.continuity.scopes("kaguya");
    const scope = query.data.scope ?? scopes[0] ?? "shared";
    const view = await db.continuity.read("kaguya", scope);
    return reply.send({
      view: view ? continuityViewSchema.parse(view) : null,
      scope,
      scopes,
    });
  });
  app.get(
    "/api/v1/continuity/people/:personId",
    options,
    async (request, reply) => {
      const params = z
        .object({ personId: z.string().min(1).max(1000) })
        .safeParse(request.params);
      const query = z
        .object({ scope: z.string().min(1).max(1000).optional() })
        .strict()
        .safeParse(request.query);
      if (!params.success || !query.success)
        return reply.code(400).send({ error: "invalid-person-scope" });
      const db = getDatabase();
      if (!db) return reply.code(503).send({ error: "database-unavailable" });
      const ownerId = `person:${params.data.personId}`;
      // 管理端可选择范围，返回正文仍服从 Memory 的有效性和同一范围证明。
      const candidates = (
        await db.sql.query<{ id: string; scope: string }>(
          `SELECT id,metadata->>'scope' scope FROM memory_nodes
      WHERE metadata->>'system'='native-v1' AND (metadata->>'ownerId'=$1 OR
        (metadata->>'ownerId'='self:kaguya' AND metadata->'relatedPersonIds' ? $1))
      ORDER BY metadata->>'occurredAt' DESC,id LIMIT 101`,
          [ownerId],
        )
      ).rows;
      const scopes = [
        ...new Set([
          ...candidates.map((n) => n.scope),
          ...(await db.continuity.scopes("kaguya")),
        ]),
      ];
      const scope =
        query.data.scope ?? scopes.find((s) => s !== "shared") ?? "shared";
      const asOf = new Date().toISOString();
      const nodes = await db.memoryGraph.native.current(
        { scope, owners: [ownerId, "self:kaguya"], asOf, query: ownerId },
        candidates
          .filter((n) => [scope, "shared"].includes(n.scope))
          .slice(0, 100)
          .map((n) => n.id),
      );
      const view = await db.continuity.read("kaguya", scope);
      return reply.send(
        personContinuitySchema.parse({
          ownerId,
          scope,
          scopes,
          nodes: nodes.slice(0, 100),
          activities:
            view?.activities.filter((a) => a.personIds.includes(ownerId)) ?? [],
          truncated: candidates.length > 100 || !!view?.activitiesTruncated,
          asOf,
        }),
      );
    },
  );
  app.post(
    "/api/v1/continuity/activities/:activityId/control",
    options,
    async (request, reply) => {
      const params = z
        .object({ activityId: z.string().min(1).max(1000) })
        .strict()
        .safeParse(request.params);
      const body = controlSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid-control" });
      const db = getDatabase();
      if (!db) return reply.code(503).send({ error: "database-unavailable" });
      const view = await db.continuity.read("kaguya", body.data.scope);
      const activity = view?.activities.find(
        (a) => a.id === params.data.activityId,
      );
      if (!activity)
        return reply.code(404).send({ error: "activity-not-found" });
      try {
        const state = {
          pause: "paused",
          resume: "active",
          abandon: "abandoned",
        } as const;
        const result = await db.continuity.change({
          agentId: "kaguya",
          operationId: `control:${body.data.operationId}`,
          expectedRevision: body.data.expectedRevision,
          activityId: activity.id,
          change: {
            state: state[body.data.action],
            reason: `管理操作：${body.data.action}`,
          },
          basis: [activity.sources[0]!],
        });
        return reply.send({ activity: result });
      } catch (error) {
        const reason =
          error instanceof Error &&
          [
            "revision-conflict",
            "operation-conflict",
            "main-slot-busy",
            "terminal-activity",
            "reevaluation-required",
            "autonomy-disabled",
            "autonomous-budget-exhausted",
          ].includes(error.message)
            ? error.message
            : "control-failed";
        return reply
          .code(reason === "control-failed" ? 500 : 409)
          .send({ error: reason });
      }
    },
  );
}
