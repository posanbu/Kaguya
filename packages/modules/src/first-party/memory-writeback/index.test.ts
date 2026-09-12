/**
 * 功能概述：使用真实 Core、ModuleHost 和 PGlite 验证后台消息写回的持久化边界。
 * fixture 安装独立身份与写回模块，submit 只登记 inbound；测试覆盖 Web/QQ、空正文、
 * 暂时失败、写入后崩溃与重启重投，断言 source 幂等和唯一终态，不启动在线回复模块。
 */
import { randomUUID } from "node:crypto";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
} from "@kaguya/engine";
import { memoryCapability, MemorySourceConflictError } from "@kaguya/memory";
import {
  catalogInformationKinds,
  defineInformationKind,
  defineInformationModuleCatalog,
} from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identityModule } from "../identity/index.js";
import {
  inboundTextInformationKind,
  personContextCompletedInformationKind,
} from "../information-kinds.js";
import { memoryWritebackModule } from "./index.js";

const contextKind = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "Context",
  description: "Test context",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const database = await createTestingDatabase();
  await database.prepareSchema();
  const catalog = defineInformationModuleCatalog(
    identityModule,
    memoryWritebackModule,
  );
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(contextKind);
  for (const definition of catalogInformationKinds(catalog)) {
    if (definition.kind.startsWith("core."))
      registry.registerBuiltin(definition);
    else registry.register(definition);
  }
  const core = new InformationCore({
    registry,
    store: database.information,
    nextInformationId: randomUUID,
  });
  const put = vi.fn(database.memory.put.bind(database.memory));
  const host = new ModuleHost({
    core,
    catalog,
    capabilities: [
      {
        capability: memoryCapability,
        value: { put, recall: database.memory.recall.bind(database.memory) },
      },
    ],
  });
  await core.start();
  const activations = catalog.definitions.map(({ manifest }) => ({
    instanceId: manifest.definitionId,
    definitionId: manifest.definitionId,
    settings: {},
  }));
  await host.start(activations);
  cleanups.push(async () => {
    await host.stop();
    await core.close();
    await database.close();
  });
  async function submit(text: string, platform = "web") {
    const context = await core.register(contextKind, {
      source: "core:test",
      occurredAt: new Date().toISOString(),
      payload: {},
      references: [],
    });
    return core.register(inboundTextInformationKind, {
      source: "adapter:test",
      occurredAt: new Date().toISOString(),
      payload: {
        text,
        source: {
          platform,
          adapterId: "test",
          senderId: "user",
          platformMessageId: context.informationId,
          destination:
            platform === "web"
              ? { kind: "web" }
              : { kind: "group", groupId: "group" },
        },
      },
      references: [
        { relation: "core:context", informationId: context.informationId },
      ],
    });
  }
  async function terminal(kind = "completed") {
    return vi.waitFor(async () => {
      const found = await database.information.find({
        kinds: [`agent.memory.writeback.${kind}`],
        limit: 100,
      });
      expect(
        found,
        JSON.stringify(
          await database.information.find({
            occurredAfter: "2000-01-01T00:00:00.000Z",
            limit: 100,
          }),
        ),
      ).toHaveLength(1);
      return found[0]!;
    });
  }
  return { database, core, host, put, submit, terminal, activations };
}
describe("durable raw Memory writeback", () => {
  it.each(["web", "qq"])(
    "writes %s inbound without any reply module",
    async (platform) => {
      const f = await fixture();
      const source = await f.submit("消息正文", platform);
      const done = await f.terminal();
      expect(done.payload).toEqual({ status: "completed", version: 1 });
      expect(JSON.stringify(done)).not.toContain("消息正文");
      const hits = await f.database.memory.recall({ query: "消息", limit: 10 });
      expect(hits.map((hit) => hit.document.sourceInformationId)).toEqual([
        source.informationId,
      ]);
      const requests = await f.database.information.find({
        kinds: ["agent.memory.writeback.requested"],
        limit: 10,
      });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests)).not.toContain("消息正文");
    },
  );
  it("records empty input without writing", async () => {
    const f = await fixture();
    await f.submit(" \n ");
    await f.terminal("empty");
    expect(f.put).not.toHaveBeenCalled();
  });
  it("recovers when put succeeds but its response is lost", async () => {
    const f = await fixture();
    f.put.mockImplementationOnce(async (input) => {
      await f.database.memory.put(input);
      throw new Error("connection lost");
    });
    await f.submit("可恢复消息");
    await f.terminal();
    expect(f.put).toHaveBeenCalledTimes(2);
    expect(
      await f.database.memory.recall({ query: "消息", limit: 10 }),
    ).toHaveLength(1);
  });
  it("records a permanent source conflict without retries", async () => {
    const f = await fixture();
    f.put.mockRejectedValue(new MemorySourceConflictError("source"));
    await f.submit("冲突消息");
    await f.terminal("failed");
    expect(f.put).toHaveBeenCalledTimes(1);
  });
  it("keeps one request and terminal when identity is delivered again", async () => {
    const f = await fixture();
    await f.submit("重复身份");
    await f.terminal();
    const identity = (
      await f.database.information.find({
        kinds: [personContextCompletedInformationKind.kind],
        limit: 1,
      })
    )[0]!;
    const replay = await f.core.register(
      personContextCompletedInformationKind,
      {
        occurredAt: identity.occurredAt,
        source: "module:test",
        payload: personContextCompletedInformationKind.payloadSchema.parse(
          identity.payload,
        ),
        references: identity.references,
      },
    );
    await vi.waitFor(async () => {
      const delivery = await f.database.sql.query(
        "SELECT state FROM information_deliveries WHERE information_id = $1 AND subscription_id LIKE '%memory.writeback.request%'",
        [replay.informationId],
      );
      expect(delivery.rows).toEqual([{ state: "acked" }]);
    });
    await f.host.stop();
    expect(
      await f.database.information.find({
        kinds: ["agent.memory.writeback.requested"],
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(
      await f.database.information.find({
        kinds: ["agent.memory.writeback.completed"],
        limit: 10,
      }),
    ).toHaveLength(1);
  });
});
