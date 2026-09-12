/**
 * 功能概述：验证热应用协调器的快照一致性、并发隔离、回滚与停机边界。
 * 主要职责：通过可控资源栅栏模拟并发保存、启动/关闭失败；确认公开结果不包含配置秘密。
 * 代码库关系：直接驱动 ConfigurationApplication，生命周期回调可控，实际 Server 集成另测。
 * 输入输出与副作用：全部使用内存快照，不访问真实配置、网络或数据库。
 */
import { expect, it, vi } from "vitest";
import { emptyUserConfigProfileSettings } from "@kaguya/config";
import {
  ConfigurationApplication,
  ConfigurationCleanupError,
  type ConfigurationSnapshot,
} from "./configuration-application.js";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(ready = true) {
  const initial: ConfigurationSnapshot = {
    profile: {
      version: 1,
      id: "default",
      name: "default",
      ...emptyUserConfigProfileSettings(),
      runtime: {
        host: "127.0.0.1",
        port: 3000,
        databaseMode: "external",
        databaseUrl: "postgresql://user:secret@localhost/db",
        webDistPath: "web",
        corsOrigins: [],
        trustProxy: false,
        rateLimitMax: 30,
        rateLimitWindowMs: 60000,
        logLevel: "silent",
        logFormat: "json",
        gatewayAllowlist: [],
      },
    },
    moduleConfigs: [
      {
        version: 1,
        instanceId: "test.main",
        definitionId: "test",
        enabled: true,
        settings: { token: "private-module-key" },
      },
    ],
  };
  let current = structuredClone(initial);
  let tail = Promise.resolve<unknown>(undefined);
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const start = vi.fn(async (_snapshot: ConfigurationSnapshot) => {});
  const stop = vi.fn(async () => {});
  const validate = vi.fn((_snapshot: ConfigurationSnapshot) => {});
  const applied = vi.fn();
  const application = new ConfigurationApplication({
    initial,
    initiallyReady: ready,
    read: async () => current,
    exclusive,
    validate,
    start,
    stop,
    applied,
  });
  return {
    application,
    start,
    stop,
    validate,
    applied,
    exclusive,
    initial,
    edit: () => {
      current = structuredClone(current);
      current.profile.identity.persona = "next persona";
    },
    changeModule: () => {
      current = {
        ...current,
        moduleConfigs: [{ ...current.moduleConfigs[0]!, enabled: false }],
      };
    },
    setPort: () => {
      current.profile.runtime!.port = 3456;
    },
  };
}
async function input(application: ConfigurationApplication) {
  const s = await application.status();
  return {
    selectedProfileId: s.selectedProfileId,
    revision: s.selectedRevision,
  };
}

it("distinguishes saved and active versions and applies each snapshot only once", async () => {
  const f = fixture();
  const initial = await f.application.status();
  f.edit();
  const saved = await input(f.application);
  expect(await f.application.status()).toMatchObject({
    state: "pending",
    appliedRevision: initial.appliedRevision,
  });
  const result = await f.application.apply(saved);
  expect(result).toMatchObject({
    status: "applied",
    application: { state: "ready", appliedRevision: saved.revision },
  });
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.start).toHaveBeenCalledOnce();
  await f.application.apply(saved);
  expect(f.start).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toMatch(
    /private-module-key|postgresql|persona/u,
  );
});
it("rejects stale module and Profile revisions before touching live resources", async () => {
  const f = fixture();
  const old = await input(f.application);
  f.changeModule();
  await expect(f.application.apply(old)).rejects.toMatchObject({
    code: "configuration_changed",
  });
  const moduleRevision = await input(f.application);
  f.edit();
  await expect(f.application.apply(moduleRevision)).rejects.toMatchObject({
    code: "configuration_changed",
  });
  expect(f.stop).not.toHaveBeenCalled();
});
it("does not expose a reusable plain configuration digest across processes", async () => {
  expect((await fixture().application.status()).selectedRevision).not.toBe(
    (await fixture().application.status()).selectedRevision,
  );
});
it("returns fixed process field names without stopping the current runtime", async () => {
  const f = fixture();
  f.setPort();
  expect(await f.application.apply(await input(f.application))).toMatchObject({
    status: "restart_required",
    restartFields: ["runtime.port"],
  });
  expect(f.stop).not.toHaveBeenCalled();
});
it("keeps the old instance for invalid configuration", async () => {
  const f = fixture();
  f.edit();
  f.validate.mockImplementation(() => {
    throw new Error("sensitive-validation-detail");
  });
  const result = await f.application.apply(await input(f.application));
  expect(result).toMatchObject({
    status: "failed",
    errorCode: "invalid_configuration",
    application: { state: "pending" },
  });
  expect(f.stop).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("sensitive");
});
it("restores the previous snapshot after failed activation without changing the saved revision", async () => {
  const f = fixture();
  const initial = await f.application.status();
  f.edit();
  f.start.mockRejectedValueOnce(new Error("provider-secret"));
  const requested = await input(f.application);
  expect(await f.application.apply(requested)).toMatchObject({
    status: "failed",
    errorCode: "apply_failed",
    application: {
      state: "pending",
      selectedRevision: requested.revision,
      appliedRevision: initial.appliedRevision,
    },
  });
  expect(f.start.mock.calls[1]![0]).toEqual(f.initial);
  expect(f.applied).not.toHaveBeenCalled();
  expect((await f.application.apply(requested)).status).toBe("applied");
});
it("remains degraded when rollback fails and allows a later retry after clean failure", async () => {
  const f = fixture();
  f.edit();
  f.start.mockRejectedValueOnce(new Error()).mockRejectedValueOnce(new Error());
  const requested = await input(f.application);
  expect(await f.application.apply(requested)).toMatchObject({
    status: "failed",
    errorCode: "rollback_failed",
    application: { state: "degraded", appliedRevision: null },
  });
  expect((await f.application.apply(requested)).status).toBe("applied");
});
it.each(["stop", "start"])(
  "refuses another owner after unsafe %s cleanup",
  async (phase) => {
    const f = fixture();
    f.edit();
    if (phase === "stop") f.stop.mockRejectedValueOnce(new Error());
    else f.start.mockRejectedValueOnce(new ConfigurationCleanupError());
    const requested = await input(f.application);
    expect((await f.application.apply(requested)).errorCode).toBe(
      "shutdown_failed",
    );
    expect((await f.application.apply(requested)).errorCode).toBe(
      "shutdown_failed",
    );
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledTimes(phase === "stop" ? 0 : 1);
  },
);
it("rejects a second apply, keeps status readable, and queues saves behind the running activation", async () => {
  const f = fixture();
  f.edit();
  const requested = await input(f.application);
  const entered = gate();
  const blocked = gate();
  f.start.mockImplementationOnce(async () => {
    entered.release();
    await blocked.promise;
  });
  const applying = f.application.apply(requested);
  await entered.promise;
  expect((await f.application.status()).state).toBe("applying");
  await expect(f.application.apply(requested)).rejects.toMatchObject({
    code: "configuration_applying",
  });
  let saved = false;
  const saving = f.exclusive(async () => {
    f.changeModule();
    saved = true;
  });
  await Promise.resolve();
  expect(saved).toBe(false);
  blocked.release();
  expect((await applying).status).toBe("applied");
  await saving;
  expect((await f.application.status()).state).toBe("pending");
});
it("waits for an ongoing application before completing shutdown and rejects further applications", async () => {
  const f = fixture();
  f.edit();
  const requested = await input(f.application);
  const entered = gate();
  const blocked = gate();
  f.start.mockImplementationOnce(async () => {
    entered.release();
    await blocked.promise;
  });
  const applying = f.application.apply(requested);
  await entered.promise;
  let closed = false;
  const closing = f.application.beginShutdown().then(() => {
    closed = true;
  });
  await expect(f.application.apply(requested)).rejects.toMatchObject({
    code: "server_stopping",
  });
  expect(closed).toBe(false);
  blocked.release();
  await applying;
  await closing;
  expect(closed).toBe(true);
});
it("can activate a previously degraded server without a rollback snapshot", async () => {
  const f = fixture(false);
  expect((await f.application.status()).appliedRevision).toBeNull();
  expect((await f.application.apply(await input(f.application))).status).toBe(
    "applied",
  );
});
