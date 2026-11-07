/**
 * 显式要求 PostgreSQL 时缺少 URL 直接失败，不能静默退回 PGlite。
 * 功能概述：用真实 Identity/Core/ModuleHost 与持久账本验收精确账号绑定，不增加人工纠错产品语义。
 * fixture 同时运行两个共享数据库的独立 Core/Host；PostgreSQL 重启还关闭并重连连接池，保留同一隔离 schema。
 * 首次 scope 写入前以可取消屏障等待两个 worker，断言 canonical entity 唯一、每条终态唯一、同名不同账号、账号跨会话复用和跨平台/适配器隔离；Web 会话/无会话匿名请求不创建长期人物。
 * 中断案例在首次 scope 落账后等待取消信号，重启恢复剩余绑定和唯一终态；不注入数据库故障。
 * 等待仅观察持久终态和队列，使用 8 秒/20 毫秒统一预算；资源创建后立即登记清理，启动失败也关闭数据库。
 * 代码库关系：复用生产 identityModule、Core registerOnce/commitTerminal 和数据库 testing 工厂；无模型、平台或 raw 数据。
 */
import { expect, it, vi } from "vitest";
import type { KaguyaDatabase } from "@kaguya/database";
import {
  createTestingDatabase,
  createPostgresTestingDatabaseScope,
} from "@kaguya/database/testing";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
} from "@kaguya/engine";
import {
  catalogInformationKinds,
  defineInformationKind,
  defineInformationModuleCatalog,
} from "@kaguya/sdk";
import { z, type SceneAddress } from "@kaguya/schema";
import { identityModule } from "./index.js";
import { closeTestResources } from "../test-support/cleanup.js";
import {
  inboundTextInformationKind,
  personContextCompletedInformationKind,
  personEntityInformationKind,
  platformAccountEntityInformationKind,
  platformAccountBindingInformationKind,
  chatScopeEntityInformationKind,
  chatScopeBindingInformationKind,
  personObservedInformationKind,
  personResolutionInformationKind,
} from "../information-kinds.js";

const wait = { timeout: 8000, interval: 20 } as const;
const runtime = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "Identity 测试",
  description: "合成身份入站的持久运行上下文。",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const postgresUrl = process.env.KAGUYA_TEST_DATABASE_URL?.trim();
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !postgresUrl)
  throw new Error("PostgreSQL Identity test URL required");
interface DatabaseSession {
  database: KaguyaDatabase;
  reconnect?: () => Promise<KaguyaDatabase>;
  close: () => Promise<void>;
}
const backends = [
  {
    name: "PGlite",
    create: async (): Promise<DatabaseSession> => {
      const database = await createTestingDatabase();
      return { database, close: () => database.close() };
    },
  },
  ...(postgresUrl
    ? [
        {
          name: "PostgreSQL",
          create: async (): Promise<DatabaseSession> => {
            const scope = await createPostgresTestingDatabaseScope(postgresUrl);
            try {
              return {
                database: await scope.connect(),
                reconnect: () => scope.reconnect(),
                close: () => scope.close(),
              };
            } catch (error) {
              await scope.close();
              throw error;
            }
          },
        },
      ]
    : []),
];
/** 可取消的测试屏障；异常清理时跟随真实 handler signal 退出，不残留监听器。 */
async function boundary(signal: AbortSignal, release: Promise<void>) {
  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([release, aborted]);
  } finally {
    removeAbort();
  }
}
async function fixture(
  create: () => Promise<DatabaseSession>,
  options: { pauseAfterScope?: boolean; competeForScope?: boolean } = {},
) {
  const session = await create();
  let database = session.database;
  const resources: Array<() => Promise<unknown>> = [];
  let sequence = 0;
  let scopePaused = false;
  const scopeContenders = new Set<number>();
  const firstScope = Promise.withResolvers<void>();
  let cores: InformationCore[] = [];
  const catalog = defineInformationModuleCatalog(identityModule);
  const now = () => new Date("2026-11-07T00:00:00.000Z");
  const start = async () => {
    cores = [];
    for (let worker = 0; worker < 2; worker++) {
      const registry = new InformationKindRegistry();
      for (const kind of [runtime, ...catalogInformationKinds(catalog)]) {
        if (kind.kind.startsWith("core.")) registry.registerBuiltin(kind);
        else registry.register(kind);
      }
      const core = new InformationCore({
        registry,
        store: database.information,
        now,
        nextInformationId: () => `identity-durable-${++sequence}`,
      });
      resources.push(() => core.close());
      if (options.pauseAfterScope || options.competeForScope) {
        const register = core.registerOnce.bind(core);
        vi.spyOn(core, "registerOnce").mockImplementation(async (...args) => {
          if (
            options.competeForScope &&
            args[0] === "memory.identity.scope" &&
            !scopeContenders.has(worker)
          ) {
            scopeContenders.add(worker);
            if (scopeContenders.size === 2) firstScope.resolve();
            await boundary(core.executionSignal!, firstScope.promise);
          }
          const result = await register(...args);
          if (
            options.pauseAfterScope &&
            !scopePaused &&
            args[0] === "memory.identity.scope"
          ) {
            const signal = core.executionSignal!;
            scopePaused = true;
            // 已写入范围后停在明确边界；Host.stop 的取消信号释放 handler，恢复不使用固定 sleep。
            await boundary(signal, new Promise<void>(() => {}));
          }
          return result;
        });
      }
      const host = new ModuleHost({ core, catalog, now, capabilities: [] });
      resources.push(() => host.stop());
      await core.start();
      await host.start([
        {
          instanceId: "identity.shared",
          definitionId: identityModule.manifest.definitionId,
          settings: {},
        },
      ]);
      cores.push(core);
    }
  };
  const close = () =>
    closeTestResources([
      () => session.close(),
      () => closeTestResources(resources),
    ]);
  try {
    await database.prepareSchema();
    await start();
    const context = await cores[0]!.register(runtime, {
      source: "core:test",
      occurredAt: now().toISOString(),
      payload: {},
      references: [],
    });
    const inbound = (
      id: string,
      address: SceneAddress,
      worker = 0,
      senderId = "account",
    ) =>
      cores[worker]!.registerOnce(
        "test.identity.inbound",
        id,
        inboundTextInformationKind,
        {
          source: "adapter:synthetic",
          occurredAt: now().toISOString(),
          payload: {
            text: "synthetic",
            source: {
              ...address,
              senderId,
              platformMessageId: id,
              selfId: "bot",
              mentions: [{ kind: "user", id: "bot" }, { kind: "all" }],
              replyTo: { platformMessageId: "prior-message", senderId: "bot" },
              sender: {
                userId: senderId,
                nickname: "same-nickname",
                card:
                  address.destination.kind === "group"
                    ? `card:${address.destination.groupId}`
                    : "private-card",
              },
            },
          },
          references: [
            { relation: "core:context", informationId: context.informationId },
          ],
        },
      );
    const all = (kind: string) =>
      database.information.find({
        kinds: [kind],
        registrationOrder: true,
        order: "asc",
        limit: 100,
      });
    const settle = (count: number) =>
      vi.waitFor(async () => {
        expect(
          await all(personContextCompletedInformationKind.kind),
        ).toHaveLength(count);
        const health = await database.information.reliable.health();
        expect(health.pending).toBe(0);
        expect(health.exhausted).toBe(0);
      }, wait);
    return {
      get database() {
        return database;
      },
      get scopeContenders() {
        return [...scopeContenders].sort();
      },
      get scopePaused() {
        return scopePaused;
      },
      inbound,
      all,
      settle,
      close,
      restart: async (beforeStart?: () => Promise<void>) => {
        // 先同步停止所有 worker 的领取，再等待释放 claim，防止另一 worker 在关闭间隙完成恢复。
        await Promise.all(cores.map((core) => core.stopReliableDelivery()));
        await closeTestResources(resources);
        await beforeStart?.();
        if (session.reconnect) {
          await database.close();
          database = await session.reconnect();
        }
        await start();
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Identity fixture start and cleanup failed",
      );
    }
    throw error;
  }
}

it.for(backends)(
  "retains exact identities across two workers, replay and restart ($name)",
  { timeout: 60_000 },
  async ({ create }) => {
    const f = await fixture(create, { competeForScope: true });
    try {
      const address: SceneAddress = {
        platform: "qq",
        adapterId: "qq.main",
        destination: { kind: "group", groupId: "group" },
      };
      const inputs = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          f.inbound(`initial-${i}`, address, i % 2),
        ),
      );
      await f.settle(8);
      expect(f.scopeContenders).toEqual([0, 1]);
      for (const kind of [
        personEntityInformationKind.kind,
        platformAccountEntityInformationKind.kind,
        platformAccountBindingInformationKind.kind,
        chatScopeEntityInformationKind.kind,
        chatScopeBindingInformationKind.kind,
      ])
        expect(await f.all(kind)).toHaveLength(1);
      expect(await f.all(personResolutionInformationKind.kind)).toHaveLength(8);
      expect(await f.all(personObservedInformationKind.kind)).toHaveLength(8);
      expect(inputs[0]!.payload.source).toMatchObject({
        ...address,
        senderId: "account",
        selfId: "bot",
        sender: {
          userId: "account",
          nickname: "same-nickname",
          card: "card:group",
        },
        mentions: [{ kind: "user", id: "bot" }, { kind: "all" }],
        replyTo: { platformMessageId: "prior-message", senderId: "bot" },
      });
      const first = (
        await f.all(personContextCompletedInformationKind.kind)
      )[0]!;
      const terminalIds = (
        await f.all(personContextCompletedInformationKind.kind)
      ).map((a) => a.informationId);
      expect(
        new Set(
          (await f.all(personContextCompletedInformationKind.kind)).flatMap(
            (a) =>
              a.references
                .filter((r) => r.relation === "core:status-of")
                .map((r) => r.informationId),
          ),
        ),
      ).toEqual(new Set(inputs.map((a) => a.informationId)));
      await f.restart();
      const replay = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          f.inbound(`initial-${i}`, address, i % 2),
        ),
      );
      expect(replay.map((a) => a.informationId)).toEqual(
        inputs.map((a) => a.informationId),
      );
      await f.inbound("after-restart", address);
      await f.settle(9);
      const after = await f.all(personContextCompletedInformationKind.kind);
      expect(after.slice(0, 8).map((a) => a.informationId)).toEqual(
        terminalIds,
      );
      expect(
        after.every(
          (a) =>
            a.payload.status === "complete" &&
            a.payload.personInformationId ===
              first.payload.personInformationId &&
            a.payload.scopeInformationId === first.payload.scopeInformationId,
        ),
      ).toBe(true);
      const isolatedInputs = await Promise.all([
        f.inbound("private", {
          ...address,
          destination: { kind: "private", userId: "account" },
        }),
        f.inbound("other-adapter", { ...address, adapterId: "other" }, 1),
        f.inbound("other-platform", { ...address, platform: "other" }),
        f.inbound("other-group", {
          ...address,
          destination: { kind: "group", groupId: "second" },
        }),
        f.inbound("other-account", address, 1, "second-account"),
      ]);
      await f.settle(14);
      const isolated = await f.all(personContextCompletedInformationKind.kind);
      const terminals = isolatedInputs.map((input) =>
        isolated.find((terminal) =>
          terminal.references.some(
            (r) =>
              r.relation === "core:status-of" &&
              r.informationId === input.informationId,
          ),
        )!,
      );
      const [direct, adapter, platform, group, otherAccount] = terminals;
      for (const samePerson of [direct!, group!]) {
        expect(samePerson.payload.personInformationId).toBe(
          first.payload.personInformationId,
        );
        expect(samePerson.payload.scopeInformationId).not.toBe(
          first.payload.scopeInformationId,
        );
      }
      for (const otherPerson of [adapter!, platform!, otherAccount!])
        expect(otherPerson.payload.personInformationId).not.toBe(
          first.payload.personInformationId,
        );
      expect(otherAccount!.payload.scopeInformationId).toBe(
        first.payload.scopeInformationId,
      );
      expect(
        new Set(
          [first, direct!, adapter!, platform!, group!].map(
            (a) => a.payload.scopeInformationId,
          ),
        ).size,
      ).toBe(5);
      // 群名片只作为当次入站的观察，不得覆盖跨会话共享人物的固定初始称呼。
      expect(
        (await f.all(personEntityInformationKind.kind)).every(
          (a) => a.payload.initialName === "same-nickname",
        ),
      ).toBe(true);
      const otherGroupObservation = (
        await f.all(personObservedInformationKind.kind)
      ).find((a) =>
        a.references.some(
          (r) =>
            r.relation === "core:caused-by" &&
            r.informationId === isolatedInputs[3]!.informationId,
        ),
      );
      expect(otherGroupObservation?.payload.card).toBe("card:second");
      expect(await f.all(personEntityInformationKind.kind)).toHaveLength(4);
      expect(
        await f.all(platformAccountEntityInformationKind.kind),
      ).toHaveLength(4);
      expect(
        await f.all(platformAccountBindingInformationKind.kind),
      ).toHaveLength(4);
      expect(await f.all(chatScopeEntityInformationKind.kind)).toHaveLength(5);
      expect(await f.all(chatScopeBindingInformationKind.kind)).toHaveLength(5);
      const web: SceneAddress = {
        platform: "web",
        adapterId: "web.ui",
        destination: {
          kind: "web",
          conversationId: "00000000-0000-4000-8000-000000000001",
        },
      };
      const webInputs = await Promise.all([
        f.inbound("web-one", web),
        f.inbound("web-two", web, 1),
        f.inbound("web-other-session", {
          ...web,
          destination: {
            kind: "web",
            conversationId: "00000000-0000-4000-8000-000000000002",
          },
        }),
        f.inbound("web-other-adapter", { ...web, adapterId: "web.other" }, 1),
        f.inbound("web-legacy-one", { ...web, destination: { kind: "web" } }),
        f.inbound(
          "web-legacy-two",
          { ...web, destination: { kind: "web" } },
          1,
        ),
      ]);
      await f.settle(20);
      const anonymous = (
        await f.all(personContextCompletedInformationKind.kind)
      ).filter((a) => a.payload.platform === "web");
      expect(anonymous).toHaveLength(6);
      const webTerminals = webInputs.map((input) =>
        anonymous.find((terminal) =>
          terminal.references.some(
            (r) =>
              r.relation === "core:status-of" &&
              r.informationId === input.informationId,
          ),
        )!,
      );
      expect(webTerminals[0]!.payload.scopeInformationId).toBe(
        webTerminals[1]!.payload.scopeInformationId,
      );
      expect(
        new Set(
          [webTerminals[0]!, ...webTerminals.slice(2)].map(
            (a) => a.payload.scopeInformationId,
          ),
        ).size,
      ).toBe(5);
      expect(
        anonymous.every(
          (a) =>
            a.payload.status === "unresolved" &&
            a.payload.scopeMode === "ephemeral" &&
            a.payload.personInformationId === undefined &&
            a.payload.accountInformationId === undefined,
        ),
      ).toBe(true);
      expect(
        new Set(anonymous.map((a) => a.payload.scopeInformationId)).size,
      ).toBe(5);
      expect(await f.all(chatScopeEntityInformationKind.kind)).toHaveLength(10);
      expect(await f.all(chatScopeBindingInformationKind.kind)).toHaveLength(
        10,
      );
      expect(await f.all(personResolutionInformationKind.kind)).toHaveLength(
        20,
      );
      expect(await f.all(personEntityInformationKind.kind)).toHaveLength(4);
    } finally {
      await f.close();
    }
  },
); // 60 秒覆盖双 worker 启动/重启、四次 8 秒持久收敛与清理；不改变运行期 deadline。

it.for(backends)(
  "resumes a partially registered identity after host interruption ($name)",
  { timeout: 40_000 },
  async ({ create }) => {
    const f = await fixture(create, { pauseAfterScope: true });
    try {
      const address: SceneAddress = {
        platform: "qq",
        adapterId: "qq.main",
        destination: { kind: "private", userId: "account" },
      };
      const inbound = await f.inbound("interrupted", address);
      await vi.waitFor(() => expect(f.scopePaused).toBe(true), wait);
      const scope = await f.all(chatScopeEntityInformationKind.kind);
      expect(scope).toHaveLength(1);
      expect(
        await f.all(personContextCompletedInformationKind.kind),
      ).toHaveLength(0);
      expect(
        await f.all(platformAccountEntityInformationKind.kind),
      ).toHaveLength(0);
      await f.restart(async () => {
        expect(
          await f.all(personContextCompletedInformationKind.kind),
        ).toHaveLength(0);
        expect(
          await f.all(platformAccountEntityInformationKind.kind),
        ).toHaveLength(0);
        const health = await f.database.information.reliable.health();
        expect(health.pending).toBe(1);
        expect(health.exhausted).toBe(0);
      });
      await f.settle(1);
      expect(
        (await f.all(chatScopeEntityInformationKind.kind))[0]!.informationId,
      ).toBe(scope[0]!.informationId);
      for (const kind of [
        chatScopeBindingInformationKind.kind,
        platformAccountEntityInformationKind.kind,
        personEntityInformationKind.kind,
        platformAccountBindingInformationKind.kind,
        personResolutionInformationKind.kind,
      ])
        expect(await f.all(kind)).toHaveLength(1);
      const terminal = (
        await f.all(personContextCompletedInformationKind.kind)
      )[0]!;
      expect(terminal.payload).toMatchObject({
        status: "complete",
        scopeMode: "canonical",
        scopeInformationId: scope[0]!.informationId,
      });
      expect(terminal.references).toContainEqual({
        relation: "core:status-of",
        informationId: inbound.informationId,
      });
      expect((await f.inbound("interrupted", address, 1)).informationId).toBe(
        inbound.informationId,
      );
      await f.settle(1);
      expect(
        (await f.all(personContextCompletedInformationKind.kind))[0]!
          .informationId,
      ).toBe(terminal.informationId);
    } finally {
      await f.close();
    }
  },
); // 40 秒覆盖双 worker 启动/重启、一次中断边界和两次持久收敛，以及清理。
