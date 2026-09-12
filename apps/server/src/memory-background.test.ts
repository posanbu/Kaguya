/**
 * 功能概述：从真实共享 composition 验证独立 Memory 后台闭环与跨 Runtime 重启恢复。
 * fixture 只启用身份模块，Memory 模块由 Profile 选项补入，绝不安装 Heartflow/Composer；
 * fake embedding/cognition 保留真实 Core、Reliable Runner、MemoryStore 与 pgvector，覆盖重启、
 * 回填、模型切换、关闭态及 provider 失败隔离。所有数据库均由本测试创建和关闭。
 */
import { createMessageComposition } from "@kaguya/composition";
import { createTestingDatabase } from "@kaguya/database/testing";
import { KaguyaRuntime } from "@kaguya/runtime";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { afterEach, describe, expect, it, vi } from "vitest";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const configs = createFirstPartyModuleConfigDefaults("test").filter(
  (config) => config.definitionId === "core.identity.normalize",
);
async function fixture(
  options: { enabled?: boolean; vector?: boolean; cognition?: boolean } = {},
) {
  const database = await createTestingDatabase({
    vector: options.vector ?? false,
  });
  cleanup.push(() => database.close());
  const embed = vi.fn(async () => [1, 0]);
  const evolve = vi.fn(
    async (input: { sourceInformationIds: readonly string[] }) => ({
      facts: [
        {
          text: "用户喜欢月亮",
          sourceInformationIds: [...input.sourceInformationIds],
        },
      ],
    }),
  );
  const create = (revision = "v1") => {
    const runtime = new KaguyaRuntime({
      database,
      ...createMessageComposition(undefined, {
        moduleConfigs: configs,
        memoryEnabled: options.enabled ?? true,
        ...(options.vector
          ? {
              embedding: {
                identity: { modelId: "test", revision, dimensions: 2 },
                embed,
              },
            }
          : {}),
        ...(options.cognition
          ? {
              cognition: { identity: { providerId: "test", revision }, evolve },
            }
          : {}),
      }),
    });
    cleanup.push(() => runtime.close());
    return runtime;
  };
  const runtime = create();
  await runtime.start();
  const submit = (
    active = runtime,
    text = "喜欢月亮",
    platformMessageId = "message",
  ) =>
    active.submit({
      adapterId: "test",
      platform: "qq",
      platformMessageId,
      occurredAt: new Date().toISOString(),
      text,
      mentions: [],
      raw: {},
      sender: { userId: "user" },
      target: { kind: "group", groupId: "group" },
    });
  const find = (kind: string) =>
    database.information.find({ kinds: [kind], limit: 100 });
  const wait = (kind: string, count = 1) =>
    vi.waitFor(
      async () => {
        const atoms = await find(kind);
        expect(
          atoms,
          JSON.stringify(await find("execution.exhausted")),
        ).toHaveLength(count);
        return atoms;
      },
      { timeout: 4000 },
    );
  return { database, runtime, create, embed, evolve, submit, find, wait };
}
describe("independent Memory background loop", () => {
  it("writes, embeds and publishes evidence without online modules", async () => {
    const f = await fixture({ vector: true, cognition: true });
    await f.submit();
    await f.wait("agent.memory.writeback.completed");
    const cognition = await f.wait("agent.memory.cognition.completed");
    await vi.waitFor(async () =>
      expect(
        (await f.database.sql.query("SELECT * FROM memory_document_vectors"))
          .rows,
      ).toHaveLength(1),
    );
    expect(cognition[0]!.payload.status).toBe("completed");
    expect(
      cognition[0]!.references.some((ref) => ref.relation === "agent:evidence"),
    ).toBe(true);
    expect(await f.find("agent.turn.candidate")).toEqual([]);
    expect(f.evolve).toHaveBeenCalledOnce();
    expect(f.evolve.mock.calls[0]![0].sourceInformationIds).toHaveLength(1);
  });
  it("rebuilds historical vectors after model revision changes on restart", async () => {
    const f = await fixture({ vector: true });
    await f.submit();
    await f.wait("agent.memory.writeback.completed");
    await vi.waitFor(async () =>
      expect(
        (await f.database.sql.query("SELECT * FROM memory_document_vectors"))
          .rows,
      ).toHaveLength(1),
    );
    await f.runtime.close();
    const next = f.create("v2");
    await next.start();
    await vi.waitFor(async () =>
      expect(
        (await f.database.sql.query("SELECT * FROM memory_document_vectors"))
          .rows,
      ).toHaveLength(2),
    );
    expect(
      await f.database.memory.recall({ query: "月亮", limit: 10 }),
    ).toHaveLength(1);
  });
  it("recovers pending cognition intent across stop without duplicating raw documents", async () => {
    const f = await fixture({ cognition: true });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.evolve.mockImplementationOnce(async () => {
      entered();
      return new Promise(() => undefined);
    });
    await f.submit();
    await started;
    await f.runtime.close();
    const next = f.create();
    await next.start();
    await f.wait("agent.memory.cognition.completed");
    expect(await f.find("agent.memory.cognition.requested")).toHaveLength(1);
    expect(
      await f.database.memory.recall({ query: "月亮", limit: 10 }),
    ).toHaveLength(1);
  });
  it("keeps raw Memory available after cognition exhausts retries", async () => {
    const f = await fixture({ cognition: true });
    f.evolve.mockRejectedValue(new Error("test-provider-failure"));
    await f.submit();
    await f.wait("execution.exhausted");
    expect(
      await f.database.memory.recall({ query: "月亮", limit: 10 }),
    ).toHaveLength(1);
    expect(await f.find("core.memory.text")).toEqual([]);
  });
  it("does not write, embed or infer when Memory is disabled", async () => {
    const f = await fixture({ enabled: false, vector: true, cognition: true });
    await f.submit();
    await f.wait("agent.person.context.completed");
    await f.runtime.close();
    expect(await f.find("agent.memory.writeback.requested")).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.evolve).not.toHaveBeenCalled();
  });
  it("retains ephemeral Web raw messages without assigning them long-term cognition", async () => {
    const f = await fixture({ cognition: true });
    await f.runtime.submit({
      adapterId: "web",
      platform: "web",
      platformMessageId: "web-message",
      occurredAt: new Date().toISOString(),
      text: "匿名消息",
      sender: { userId: "anonymous" },
      target: { kind: "web" },
      mentions: [],
      raw: {},
    });
    const completed = await f.wait("agent.memory.writeback.completed");
    await vi.waitFor(async () => {
      const result = await f.database.sql.query(
        "SELECT state FROM information_deliveries WHERE information_id = $1 AND subscription_id LIKE '%cognition.request%'",
        [completed[0]!.informationId],
      );
      expect(result.rows).toEqual([{ state: "acked" }]);
    });
    expect(f.evolve).not.toHaveBeenCalled();
    expect(
      await f.database.memory.recall({ query: "匿名", limit: 10 }),
    ).toHaveLength(1);
  });
});
