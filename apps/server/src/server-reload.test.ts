/**
 * 功能概述：通过真实 HTTP、配置文件、Runtime 与 PGlite 验证无进程重启的配置热应用。
 * 主要职责：覆盖凭据/人设/白名单/模块快照切换、旧入口 fencing、持久化写锁、回滚与恢复。
 * 代码库关系：只替换外部数据库连接与模型 provider；server.ts 的应用编排和 HTTP 鉴权使用实际实现。
 * 输入输出与副作用：每例独立临时目录及数据库，使用虚构凭据，关闭 Server 后清理全部测试资源。
 */
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileUserConfigManager } from "@kaguya/config";
import { KaguyaDatabase } from "@kaguya/database";
import { createTestingDatabase } from "@kaguya/database/testing";
import { KaguyaRuntime } from "@kaguya/runtime";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { startKaguyaServer, type StartedKaguyaServer } from "./server.js";
import { AdapterHost } from "./adapter-host.js";
import { createServerConfig } from "./config.js";

vi.mock("@ai-sdk/openai-compatible", async () => {
  const { createRepeatingDeterministicModel } =
    await import("@kaguya/llm/testing");
  return {
    createOpenAICompatible: vi.fn(() => ({
      chatModel: () =>
        createRepeatingDeterministicModel({ text: "reload test reply" }),
    })),
  };
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  vi.restoreAllMocks();
});
const headers = { authorization: "Bearer test-reload-gateway-token" };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(incomplete = false) {
  const root = await mkdtemp(join(tmpdir(), "kaguya-reload-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
  const profile = await manager.getProfile("default");
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "<main>reload</main>");
  const settings = {
    name: "default",
    acknowledgedWarnings: [],
    identity: profile.identity,
    ai: {
      defaultProviderId: "p",
      modelTiers: {
        light: { providerId: "p", modelId: "test" },
        heavy: { providerId: "p", modelId: "test" },
      },
      providers: [
        {
          id: "p",
          type: "openai-compatible",
          enabled: true,
          apiKey: "original-private-key",
          baseUrl: "https://example.com/v1",
          models: ["test"],
          settings: {},
        },
      ],
    },
    memory: { enabled: false },
    platforms: [],
    runtime: {
      host: "127.0.0.1",
      port: 3000,
      databaseMode: "external" as const,
      databaseUrl: "postgresql://test@localhost/db",
      webDistPath: web,
      corsOrigins: [],
      trustProxy: false as const,
      rateLimitMax: 1000,
      rateLimitWindowMs: 60000,
      logLevel: "silent" as const,
      logFormat: "json" as const,
      gatewayAllowlist: [],
    },
  };
  const configured = await manager.replaceProfile("default", {
    ...settings,
    ...(incomplete ? { ai: profile.ai } : {}),
  });
  const databases: KaguyaDatabase[] = [];
  const connect = vi
    .spyOn(KaguyaDatabase, "connect")
    .mockImplementation(async () => {
      const db = await createTestingDatabase();
      databases.push(db);
      return db;
    });
  const serverConfig = createServerConfig(
    configured,
    { configRoot: root, development: false },
    () => "test-reload-gateway-token",
  );
  const server = await startKaguyaServer({ ...serverConfig, port: 0 });
  cleanup.push(() => server.close());
  return { root, manager, server, connect, databases, settings };
}
async function status(server: StartedKaguyaServer) {
  const response = await server.app.inject({
    url: "/api/v1/configuration/status",
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json().data;
}
async function apply(
  server: StartedKaguyaServer,
  snapshot: Awaited<ReturnType<typeof status>>,
) {
  return server.app.inject({
    method: "POST",
    url: "/api/v1/configuration/apply",
    headers,
    payload: {
      selectedProfileId: snapshot.selectedProfileId,
      revision: snapshot.selectedRevision,
    },
  });
}
async function save(server: StartedKaguyaServer) {
  const loaded = (
    await server.app.inject({ url: "/api/v1/profiles/default", headers })
  ).json().data.profile;
  const response = await server.app.inject({
    method: "PUT",
    url: "/api/v1/profiles/default",
    headers,
    payload: {
      name: loaded.name,
      identity: { ...loaded.identity, persona: "updated persona" },
      acknowledgedWarnings: [],
      ai: {
        ...loaded.ai,
        providers: loaded.ai.providers.map((p: object) => ({
          ...p,
          apiKey: "updated-private-key",
        })),
      },
      memory: { enabled: true },
      platforms: loaded.platforms,
      gatewayAllowlist: ["qq:group:123"],
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().data;
}
it("replaces downstream instances while retaining HTTP, authentication, database and live inspection", async () => {
  const f = await fixture();
  const oldRuntime = f.server.runtime!;
  const oldHost = f.server.adapterHost;
  const address = f.server.app.server.address();
  const dbClose = vi.spyOn(f.databases[0]!, "close");
  const saved = await save(f.server);
  expect(saved.application.state).toBe("pending");
  const response = await apply(f.server, saved.application);
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({
    status: "applied",
    application: {
      state: "ready",
      appliedRevision: saved.application.selectedRevision,
    },
  });
  expect(f.server.runtime).not.toBe(oldRuntime);
  expect(f.server.adapterHost).not.toBe(oldHost);
  expect(f.server.app.server.address()).toEqual(address);
  expect(dbClose).not.toHaveBeenCalled();
  expect(f.connect).toHaveBeenCalledOnce();
  expect(() => oldRuntime.inspectModules()).toThrow();
  expect(oldHost.status().runtime.ingress).toBe("stopping");
  expect(createOpenAICompatible).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: "updated-private-key" }),
  );
  expect(
    (await f.server.app.inject({ url: "/api/v1/inspection/modules", headers }))
      .statusCode,
  ).toBe(200);
  const input = await f.server.app.inject({
    method: "POST",
    url: "/api/v1/messages",
    headers,
    payload: { text: "after hot apply" },
  });
  expect(input.statusCode).toBe(202);
  await vi.waitFor(async () =>
    expect(
      await f.databases[0]!.information.find({
        kinds: ["core.message.inbound.text"],
        limit: 10,
      }),
    ).toHaveLength(1),
  );
  const current = f.server.runtime;
  expect(
    (await apply(f.server, await status(f.server))).json().data.status,
  ).toBe("applied");
  expect(f.server.runtime).toBe(current);
  const list = (
    await f.server.app.inject({ url: "/api/v1/profiles", headers })
  ).json().data;
  expect(list.status).toBe("ready");
});
it("keeps management available, fences ingress and serializes saves while old work is draining", async () => {
  const f = await fixture();
  const saved = await save(f.server);
  const oldRuntime = f.server.runtime!;
  const entered = gate();
  const blocked = gate();
  const close = oldRuntime.close.bind(oldRuntime);
  vi.spyOn(oldRuntime, "close").mockImplementationOnce(async (options) => {
    expect(options).toEqual({ drain: true });
    entered.release();
    await blocked.promise;
    await close(options);
  });
  const applying = apply(f.server, saved.application);
  await entered.promise;
  expect((await status(f.server)).state).toBe("applying");
  expect((await f.server.app.inject("/healthz")).statusCode).toBe(200);
  expect(
    (await f.server.app.inject({ url: "/api/v1/inspection/modules", headers }))
      .statusCode,
  ).toBe(503);
  expect(
    (
      await f.server.app.inject({
        method: "POST",
        url: "/api/v1/messages",
        headers,
        payload: { text: "blocked" },
      })
    ).statusCode,
  ).toBe(503);
  expect((await apply(f.server, saved.application)).statusCode).toBe(409);
  let finishedSave = false;
  const saving = save(f.server).then(() => {
    finishedSave = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(finishedSave).toBe(false);
  blocked.release();
  expect((await applying).json().data.status).toBe("applied");
  await saving;
});
it("rejects stale saved revisions and detects module edits without disturbing the active instance", async () => {
  const f = await fixture();
  const initial = await status(f.server);
  const runtime = f.server.runtime;
  const saved = await save(f.server);
  expect((await apply(f.server, initial)).statusCode).toBe(409);
  const instance = (await readdir(join(f.root, "modules")))[0]!;
  const path = join(f.root, "modules", instance, "config.json");
  const module = JSON.parse(await readFile(path, "utf8"));
  module.enabled = !module.enabled;
  await writeFile(path, JSON.stringify(module));
  expect((await status(f.server)).selectedRevision).not.toBe(
    saved.application.selectedRevision,
  );
  expect((await apply(f.server, saved.application)).statusCode).toBe(409);
  expect(f.server.runtime).toBe(runtime);
});
it("rejects process configuration changes before stopping the live instance", async () => {
  const f = await fixture();
  const runtime = f.server.runtime;
  await f.manager.replaceProfile("default", {
    ...f.settings,
    runtime: { ...f.settings.runtime, port: 4321 },
  });
  const result = (await apply(f.server, await status(f.server))).json().data;
  expect(result).toMatchObject({
    status: "restart_required",
    restartFields: ["runtime.port"],
  });
  expect(f.server.runtime).toBe(runtime);
});
it("recreates the old snapshot after activation failure and can subsequently retry", async () => {
  const f = await fixture();
  const initial = await status(f.server);
  const old = f.server.runtime;
  const saved = await save(f.server);
  vi.spyOn(KaguyaRuntime.prototype, "start").mockRejectedValueOnce(
    new Error("private-failure-detail"),
  );
  const response = await apply(f.server, saved.application);
  const result = response.json().data;
  expect(result).toMatchObject({
    status: "failed",
    errorCode: "apply_failed",
    application: {
      appliedRevision: initial.appliedRevision,
      selectedRevision: saved.application.selectedRevision,
    },
  });
  expect(response.body).not.toMatch(
    /private-failure-detail|original-private-key|updated-private-key/u,
  );
  expect(f.server.runtime).toBeDefined();
  expect(f.server.runtime).not.toBe(old);
  expect(f.server.adapterHost.status().runtime.ingress).toBe("ready");
  expect((await apply(f.server, saved.application)).json().data.status).toBe(
    "applied",
  );
});
it("recovers from startup configuration degradation after saving a complete profile", async () => {
  const f = await fixture(true);
  expect(f.server.runtime).toBeUndefined();
  const { runtime: _runtime, ...settings } = f.settings;
  const saved = await f.server.app.inject({
    method: "PUT",
    url: "/api/v1/profiles/default",
    headers,
    payload: { ...settings, gatewayAllowlist: [] },
  });
  expect(saved.statusCode).toBe(200);
  expect(
    (await apply(f.server, saved.json().data.application)).json().data.status,
  ).toBe("applied");
  expect(f.server.runtime).toBeDefined();
});
it("authenticates apply before validation and never exposes secrets in status", async () => {
  const f = await fixture();
  const response = await f.server.app.inject({
    method: "POST",
    url: "/api/v1/configuration/apply",
    payload: { revision: "invalid" },
  });
  expect(response.statusCode).toBe(401);
  expect(
    (
      await f.server.app.inject({
        method: "POST",
        url: "/api/v1/configuration/apply",
        headers,
        payload: { revision: "invalid" },
      })
    ).statusCode,
  ).toBe(400);
  const state = await f.server.app.inject({
    url: "/api/v1/configuration/status",
    headers,
  });
  expect(state.headers["cache-control"]).toBe("no-store");
  expect(state.body).not.toMatch(/private-key|databaseUrl|persona/u);
});

it("keeps management available after rollback failure and recovers on explicit retry", async () => {
  const f = await fixture();
  const saved = await save(f.server);
  vi.spyOn(KaguyaRuntime.prototype, "start")
    .mockRejectedValueOnce(new Error("candidate failure"))
    .mockRejectedValueOnce(new Error("rollback failure"));
  expect((await apply(f.server, saved.application)).json().data).toMatchObject({
    status: "failed",
    errorCode: "rollback_failed",
    application: { state: "degraded", appliedRevision: null },
  });
  expect(f.server.runtime).toBeUndefined();
  expect(
    (await f.server.app.inject({ url: "/api/v1/profiles", headers }))
      .statusCode,
  ).toBe(200);
  expect((await apply(f.server, saved.application)).json().data.status).toBe(
    "applied",
  );
});

it("rolls back adapter startup failure and applies persisted NapCat settings on retry", async () => {
  const f = await fixture();
  const initial = await status(f.server);
  const saved = await f.server.app.inject({
    method: "PUT",
    url: "/api/v1/napcat",
    headers,
    payload: {
      enabled: false,
      wsUrl: "ws://127.0.0.1:9",
      selfId: "123",
      accessToken: "fake-napcat-token",
      reconnectMs: 4000,
    },
  });
  expect(saved.statusCode).toBe(200);
  const next = saved.json().data.application;
  vi.spyOn(AdapterHost.prototype, "start").mockRejectedValueOnce(
    new Error("adapter failed"),
  );
  expect((await apply(f.server, next)).json().data).toMatchObject({
    status: "failed",
    application: { appliedRevision: initial.appliedRevision },
  });
  expect((await apply(f.server, next)).json().data.status).toBe("applied");
  expect((await status(f.server)).appliedRevision).toBe(next.selectedRevision);
});

it("switches the selected Profile with matching applied identity", async () => {
  const f = await fixture();
  const old = f.server.runtime;
  const created = await f.server.app.inject({
    method: "POST",
    url: "/api/v1/profiles",
    headers,
    payload: { name: "alternate" },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().data.profile.id;
  const { runtime: _runtime, ...settings } = f.settings;
  const saved = await f.server.app.inject({
    method: "PUT",
    url: `/api/v1/profiles/${id}`,
    headers,
    payload: { ...settings, name: "alternate", gatewayAllowlist: [] },
  });
  expect(saved.statusCode).toBe(200);
  expect(f.server.runtime).toBe(old);
  const selection = await f.server.app.inject({
    method: "PUT",
    url: "/api/v1/profiles/selection",
    headers,
    payload: { selectedProfileId: id },
  });
  expect(selection.statusCode).toBe(200);
  expect(
    (await apply(f.server, selection.json().data.application)).json().data
      .application,
  ).toMatchObject({
    state: "ready",
    selectedProfileId: id,
    appliedProfileId: id,
  });
  expect(f.server.runtime).not.toBe(old);
});

it("reports successful persistence even when a separate module snapshot is unreadable", async () => {
  const f = await fixture();
  const old = f.server.runtime;
  const instance = (await readdir(join(f.root, "modules")))[0]!;
  await writeFile(
    join(f.root, "modules", instance, "config.json"),
    "invalid-json",
  );
  const saved = await save(f.server);
  expect(saved.application).toBeUndefined();
  expect((await f.manager.getProfile("default")).identity.persona).toBe(
    "updated persona",
  );
  expect(
    (
      await f.server.app.inject({
        url: "/api/v1/configuration/status",
        headers,
      })
    ).statusCode,
  ).toBe(503);
  expect(f.server.runtime).toBe(old);
});
