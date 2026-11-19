import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import { createGatewayAuthenticator } from "./gateway-auth.js";
import { registerContinuityRoutes } from "./continuity-routes.js";

describe("continuity management routes", () => {
  it("uses management auth, preserves private contents, applies versioned controls and deduplicates retries", async () => {
    const db = await createTestingDatabase();
    const app = Fastify();
    try {
      await db.prepareSchema();
      await db.continuity.configure({
        agentId: "kaguya",
        operationId: "configure",
        expectedRevision: 0,
        policy: {
          version: "test.v1",
          enabled: true,
          timeZone: "Asia/Shanghai",
          dailyModelCalls: 24,
          subjectiveTtlMs: 1800000,
        },
        basis: [],
      });
      const source = (
        await db.information.find({
          kinds: ["agent.continuity.policy.v1"],
          limit: 1,
        })
      )[0]!.informationId;
      const a = await db.continuity.create({
        agentId: "kaguya",
        operationId: "create",
        expectedRevision: 1,
        activity: {
          id: "reading",
          scope: "private:a",
          kind: "plan",
          title: "私人笔记",
          goal: "只在原范围显示",
          sources: [source],
        },
      });
      const personId = randomUUID(),
        privateNode = randomUUID(),
        otherNode = randomUUID();
      await db.memoryGraph.native.publish({
        operationId: "person-view-fixture",
        actor: "manual",
        nodes: [
          {
            expectedRevision: 0,
            node: {
              id: privateNode,
              content: "喜欢科研讨论",
              metadata: {
                system: "native-v1",
                kind: "person",
                ownerId: `person:${personId}`,
                scope: "private:a",
                occurredAt: new Date().toISOString(),
                level: 1,
                revision: 1,
                tags: ["关系印象"],
              },
            },
          },
          {
            expectedRevision: 0,
            node: {
              id: otherNode,
              content: "不可跨范围显示的偏好",
              metadata: {
                system: "native-v1",
                kind: "person",
                ownerId: `person:${personId}`,
                scope: "private:b",
                occurredAt: new Date().toISOString(),
                level: 1,
                revision: 1,
                tags: [],
              },
            },
          },
        ],
        edges: [],
      });
      registerContinuityRoutes(
        app,
        () => db,
        createGatewayAuthenticator("test-only-placeholder"),
      );
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/continuity?scope=private:a",
          })
        ).statusCode,
      ).toBe(401);
      const headers = { authorization: "Bearer test-only-placeholder" };
      const person = await app.inject({
        method: "GET",
        url: `/api/v1/continuity/people/${personId}?scope=private:a`,
        headers,
      });
      expect(person.statusCode).toBe(200);
      expect(person.json().nodes.map((n: { id: string }) => n.id)).toEqual([
        privateNode,
      ]);
      expect(person.body).not.toContain("不可跨范围显示的偏好");
      const start = {
        operationId: randomUUID(),
        expectedRevision: a.revision,
        action: "resume",
        scope: "private:a",
      };
      const invoke = (payload: Record<string, unknown>) =>
        app.inject({
          method: "POST",
          url: "/api/v1/continuity/activities/reading/control",
          headers,
          payload,
        });
      const first = await invoke(start);
      expect(first.statusCode).toBe(200);
      expect((await invoke(start)).json()).toEqual(first.json());
      const other = await app.inject({
        method: "GET",
        url: "/api/v1/continuity?scope=private:b",
        headers,
      });
      expect(other.json().view).toMatchObject({
        busy: true,
        mainActivityId: null,
        activities: [],
      });
      expect(other.body).not.toContain("私人笔记");
      expect(
        (await invoke({ ...start, operationId: randomUUID(), action: "pause" }))
          .statusCode,
      ).toBe(409);
      const paused = await invoke({
        ...start,
        operationId: randomUUID(),
        action: "pause",
        expectedRevision: first.json().activity.revision,
      });
      expect(paused.json().activity.state).toBe("paused");
    } finally {
      await app.close();
      await db.close();
    }
  });
});
