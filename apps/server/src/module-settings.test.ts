/**
 * 功能概述：验证模块编辑真正的文件替换、公开投影、并发冲突和 HTTP 认证边界。
 * 主要职责：临时配置夹具保留隐藏值，竞争相同 revision 必须仅一次成功；非法输入不得落盘。
 * 代码库关系：直接使用 Catalog/Zod、配置文件和 createHttpApplication，不启动运行时。
 * 输入输出与副作用：只写临时目录，无真实消息或配置应用，结束清理所有文件。
 */
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "@kaguya/schema";
import { loadModuleInstanceConfigs } from "@kaguya/config";
import { createMessageCatalog } from "@kaguya/composition";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { ModuleSettingsManagement } from "./module-settings-management.js";
import { createHttpApplication } from "./app.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// Windows 普通进程可能没有创建符号链接的权限（未开启 Developer Mode），
// 此时依赖 symlink 夹具的用例无法构造前置条件，在收集期探测并跳过。
function canCreateSymlinks(): boolean {
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "kaguya-symlink-probe-"));
    symlinkSync(join(root, "target"), join(root, "link"));
    return true;
  } catch {
    return false;
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}
async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "module-settings-"));
  roots.push(rootDir);
  const original = createMessageCatalog().definitions[0]!;
  const catalog = {
    definitions: [
      {
        ...original,
        manifest: {
          ...original.manifest,
          definitionId: "test.settings",
          settingsSchema: z.strictObject({
            count: z.number().int().min(1).max(4).meta({
              public: true,
              title: "次数",
              description: "最大四次",
              default: 2,
            }),
            fixed: z.string().meta({
              public: true,
              title: "只读值",
              description: "不可更改",
              readOnly: true,
            }),
            secret: z.string(),
          }),
        },
      },
    ],
  };
  const defaults = [
    {
      version: 1 as const,
      instanceId: "test.default",
      definitionId: "test.settings",
      enabled: true,
      settings: { count: 2, fixed: "fixed", secret: "DO-NOT-EXPOSE" },
    },
  ];
  await loadModuleInstanceConfigs({ rootDir, defaults });
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(op: () => Promise<T>) => {
    const result = tail.then(op, op);
    tail = result.catch(() => undefined);
    return result;
  };
  const service = new ModuleSettingsManagement({
    rootDir,
    catalog,
    defaults,
    exclusive,
  });
  const view = await service.get("test.settings");
  const input = {
    revision: view.instances[0]!.revision,
    enabled: false,
    settings: { count: 3, fixed: "fixed" },
  };
  const path = join(rootDir, "modules/test.default/config.json");
  return { service, input, path, rootDir };
}
it("projects explicit metadata and atomically rejects stale concurrent replacements", async () => {
  const { service, input, path } = await fixture();
  expect(JSON.stringify(await service.get("test.settings"))).not.toContain(
    "DO-NOT-EXPOSE",
  );
  const results = await Promise.allSettled([
    service.replace("test.settings", "test.default", input),
    service.replace("test.settings", "test.default", {
      ...input,
      settings: { count: 4, fixed: "fixed" },
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    enabled: false,
    settings: { count: 3, secret: "DO-NOT-EXPOSE" },
  });
});
it("rejects invalid, missing, hidden and read-only fields without changing bytes", async () => {
  const { service, input, path } = await fixture();
  const before = await readFile(path, "utf8");
  for (const settings of [
    { count: 99, fixed: "fixed" },
    { fixed: "fixed" },
    { count: 3, fixed: "changed" },
    { count: 3, fixed: "fixed", secret: "replacement" },
  ]) {
    await expect(
      service.replace("test.settings", "test.default", { ...input, settings }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(path, "utf8")).toBe(before);
  }
  await expect(
    service.replace("test.settings", "../test.default", input),
  ).rejects.toMatchObject({ status: 404 });
});
it.runIf(canCreateSymlinks())(
  "fails closed for invalid disk settings and refuses a symlink destination",
  async () => {
    const { service, input, path, rootDir } = await fixture();
    const before = await readFile(path, "utf8");
    await writeFile(path, before.replace('"count": 2', '"count": 99'));
    await expect(service.get("test.settings")).rejects.toMatchObject({
      status: 503,
    });
    const target = join(rootDir, "target.json");
    await writeFile(target, before);
    await unlink(path);
    await symlink(target, path);
    await expect(
      service.replace("test.settings", "test.default", input),
    ).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(before);
  },
);
it("first-party editable schemas expose names, constraints and no invented instances", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "module-public-"));
  roots.push(rootDir);
  const defaults = createFirstPartyModuleConfigDefaults();
  await loadModuleInstanceConfigs({ rootDir, defaults });
  const service = new ModuleSettingsManagement({
    rootDir,
    defaults,
    catalog: createMessageCatalog(),
    exclusive: (op) => op(),
  });
  const heartbeat = await service.get("agent.heartbeat.short");
  expect(heartbeat.fields).toContainEqual(
    expect.objectContaining({
      key: "maxReplacementAttempts",
      title: "最大替换次数",
      maximum: 20,
      default: 3,
    }),
  );
  expect(
    (await service.get("agent.heartflow.online")).fields.find(
      (f) => f.key === "botNames",
    )?.readOnly,
  ).toBe(true);
  expect((await service.get("agent.memory.cognition")).instances).toEqual([]);
});
it("maps an invalid array element to its public field path", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "module-array-"));
  roots.push(rootDir);
  const original = createMessageCatalog().definitions[0]!;
  const catalog = {
    definitions: [
      {
        ...original,
        manifest: {
          ...original.manifest,
          definitionId: "test.array",
          settingsSchema: z.strictObject({
            names: z
              .array(z.string().min(1))
              .meta({ public: true, title: "名称", description: "名称列表" }),
          }),
        },
      },
    ],
  };
  const defaults = [
    {
      version: 1 as const,
      instanceId: "array.default",
      definitionId: "test.array",
      enabled: true,
      settings: { names: ["valid"] },
    },
  ];
  await loadModuleInstanceConfigs({ rootDir, defaults });
  const service = new ModuleSettingsManagement({
    rootDir,
    catalog,
    defaults,
    exclusive: (op) => op(),
  });
  const view = await service.get("test.array");
  await expect(
    service.replace("test.array", "array.default", {
      revision: view.instances[0]!.revision,
      enabled: true,
      settings: { names: [""] },
    }),
  ).rejects.toMatchObject({ fields: [{ path: "names.0" }] });
});
it("requires management auth before lookup and returns safe field errors", async () => {
  const { service, input } = await fixture();
  const app = await createHttpApplication({
    moduleSettings: service,
    config: {
      host: "127.0.0.1",
      port: 3000,
      gatewayToken: "test-gateway-token-12345",
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 100,
      rateLimitWindowMs: 60000,
      databaseUrl: "postgresql://localhost/test",
      configRoot: "/tmp/test",
      development: false,
      webDistPath: "/tmp/web",
      logLevel: "silent",
      logFormat: "json",
      inboundAllowlist: [],
      outboundAllowlist: [],
      napcat: {
        enabled: false,
        adapterId: "napcat.qq.main",
        reconnectMs: 3000,
      },
    },
  });
  try {
    const url = "/api/v1/modules/test.settings/instances/test.default/settings";
    expect(
      (await app.inject({ method: "PUT", url, payload: {} })).statusCode,
    ).toBe(401);
    const headers = { authorization: "Bearer test-gateway-token-12345" };
    const result = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: { ...input, settings: { count: 100, fixed: "fixed" } },
    });
    expect(result.statusCode).toBe(400);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json().error.fields[0].path).toBe("count");
    expect(result.body).not.toContain("DO-NOT-EXPOSE");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/modules/test.settings/settings",
          headers,
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});
