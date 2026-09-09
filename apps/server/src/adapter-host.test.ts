import { Writable } from "node:stream";
import { createLogger, closeLogger } from "@kaguya/logger";
import {
  AdapterIngressUnavailableError,
  type HostedAdapter,
  type AdapterConnectionStatus,
  type PlatformInboundMessage,
} from "@kaguya/platform-adapters";
import { afterEach, expect, it, vi } from "vitest";
import { AdapterHost } from "./adapter-host.js";
import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function fixture() {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: "host-test",
    level: "debug",
    stream: new Writable({
      write(chunk, _encoding, callback) {
        logs.push(JSON.parse(String(chunk)));
        callback();
      },
    }),
  });
  const host = new AdapterHost(logger, {
    platforms: ["qq"],
    userIds: ["allowed"],
    groupIds: [],
  });
  cleanup.push(() => closeLogger(logger));
  return { host, logs };
}
function adapter(
  adapterId: string,
  overrides: Partial<HostedAdapter> = {},
): HostedAdapter {
  return {
    adapterId,
    type: "napcat",
    platform: "qq",
    enabled: true,
    start: async () => {},
    stop: async () => {},
    ...overrides,
  };
}
const message: PlatformInboundMessage = {
  adapterId: "qq",
  platform: "qq",
  platformMessageId: "external",
  occurredAt: "2026-09-09T00:00:00.000Z",
  text: "完整正文\nsecond line",
  mentions: [],
  target: { kind: "private", userId: "allowed" },
  sender: { userId: "allowed" },
  raw: { token: "raw-secret", url: "ws://private" },
};
it("starts independently, isolates failures and disabled/invalid adapters, sorts and clones snapshots", async () => {
  const { host } = fixture();
  const failedStop = vi.fn(async () => {});
  host.register(adapter("z"));
  host.register(
    adapter("b", {
      start: async () => {
        throw new Error("credential-secret");
      },
      stop: failedStop,
    }),
  );
  const start = vi.fn(async () => {});
  host.register(adapter("a", { enabled: false, start }));
  host.register(
    adapter("c", { configurationError: "configuration_invalid", start }),
  );
  host.finalizeRuntime(undefined, "database_unavailable");
  await host.start();
  const status = host.status();
  expect(status.adapterHostState).toBe("running");
  expect(status.adapters.map((a) => [a.adapterId, a.lifecycle])).toEqual([
    ["a", "disabled"],
    ["b", "failed"],
    ["c", "failed"],
    ["z", "running"],
  ]);
  expect(start).not.toHaveBeenCalled();
  expect(failedStop).toHaveBeenCalledOnce();
  expect(JSON.stringify(status)).not.toContain("credential-secret");
  Object.assign(status.adapters[0]!, { lifecycle: "running" });
  expect(host.status().adapters[0]?.lifecycle).toBe("disabled");
  await host.stop();
});
it("updates connection snapshots before logging and clears stale retry fields", async () => {
  const { host, logs } = fixture();
  let report: (status: AdapterConnectionStatus) => void = () => {};
  host.register(
    adapter("qq", {
      start: async (callback) => {
        report = callback;
      },
    }),
  );
  await host.start();
  report({
    connectivity: "retrying",
    attempt: 1,
    nextRetryAt: "2026-09-09T00:00:01.000Z",
    errorType: "connection_failed",
  });
  expect(logs.at(-1)).toMatchObject(host.status().adapters[0]!);
  report({ connectivity: "connected", attempt: 2 });
  expect(host.status().adapters[0]).not.toHaveProperty("nextRetryAt");
  expect(host.status().adapters[0]).not.toHaveProperty("errorType");
  await host.stop();
  report({ connectivity: "connected" });
  expect(host.status().adapters[0]?.lifecycle).toBe("stopped");
});
it("logs full normalized inbound text, filters before submission and records the receipt", async () => {
  const { host, logs } = fixture();
  host.register(adapter("qq"));
  const submit = vi.fn(async () => ({
    rootInformationId: "root-1",
    deliveries: [],
  }));
  host.finalizeRuntime({ submit });
  const filtered = { ...message, sender: { userId: "denied" } };
  expect(host.acceptInbound(filtered)).toBe(false);
  expect(submit).not.toHaveBeenCalled();
  expect(host.acceptInbound(message)).toBe(true);
  await host.ingress.submit(message);
  expect(logs.map((l) => l.event)).toEqual([
    "napcat.inbound.received",
    "napcat.inbound.filtered",
    "napcat.inbound.received",
    "napcat.inbound.accepted",
    "napcat.inbound.submitted",
  ]);
  expect(logs[0]?.messageText).toBe(message.text);
  expect(logs.at(-1)?.rootInformationId).toBe("root-1");
  expect(JSON.stringify(logs)).not.toMatch(/raw-secret|ws:\/\/private/);
});
it("rejects unavailable ingress without queueing, keeps Web synchronous and freezes binding", async () => {
  const { host, logs } = fixture();
  host.register(adapter("qq"));
  host.finalizeRuntime(undefined, "runtime_start_failed");
  host.acceptInbound(message);
  await expect(host.ingress.submit(message)).rejects.toMatchObject({
    code: "runtime_unavailable",
    reason: "runtime_start_failed",
  });
  expect(() =>
    host.webGateway.ingest({ text: message.text, requestId: "web" }),
  ).toThrow(AdapterIngressUnavailableError);
  expect(logs.map((l) => l.event)).toEqual([
    "napcat.inbound.received",
    "napcat.inbound.accepted",
    "napcat.inbound.failed",
    "web.inbound.received",
    "web.inbound.accepted",
    "web.inbound.failed",
  ]);
  expect(() =>
    host.finalizeRuntime({
      submit: async () => ({ rootInformationId: "late", deliveries: [] }),
    }),
  ).toThrow("immutable");
});
it("returns immediately for Web while observing async receipt/failure", async () => {
  const { host, logs } = fixture();
  let finish: (value: {
    rootInformationId: string;
    deliveries: [];
  }) => void = () => {};
  host.finalizeRuntime({
    submit: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  host.webGateway.ingest({ text: message.text, requestId: "web" });
  expect(logs.map((l) => l.event)).toEqual([
    "web.inbound.received",
    "web.inbound.accepted",
  ]);
  finish({ rootInformationId: "web-root", deliveries: [] });
  await vi.waitFor(() =>
    expect(logs.at(-1)?.event).toBe("web.inbound.submitted"),
  );
});
it("marks all ingress stopping before stops, continues on failure and is idempotent", async () => {
  const { host } = fixture();
  const stop = vi.fn(async () => {
    expect(host.status().adapters.every((a) => a.ingress === "stopping")).toBe(
      true,
    );
    expect(() =>
      host.webGateway.ingest({ text: "late", requestId: "late" }),
    ).toThrow(AdapterIngressUnavailableError);
  });
  host.register(
    adapter("a", {
      stop: async () => {
        await stop();
        throw new Error("secret");
      },
    }),
  );
  host.register(adapter("b", { stop }));
  host.finalizeRuntime({
    submit: async () => ({ rootInformationId: "x", deliveries: [] }),
  });
  await host.start();
  const stopping = host.stop();
  expect(host.stop()).toBe(stopping);
  await expect(stopping).rejects.toThrow("Adapter shutdown failed");
  expect(stop).toHaveBeenCalledTimes(2);
  expect(host.status().adapters.map((a) => a.lifecycle)).toEqual([
    "failed",
    "stopped",
  ]);
});
it("protects the status endpoint with management scope and keeps health live while degraded", async () => {
  const { host } = fixture();
  host.register(adapter("qq"));
  host.finalizeRuntime(undefined, "database_unavailable");
  await host.start();
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    gatewayToken: "management-token",
    corsOrigins: [],
    trustProxy: false,
    rateLimitMax: 1,
    rateLimitWindowMs: 60000,
    databaseUrl: "postgresql://private",
    configRoot: "/tmp/unused",
    development: false,
    webDistPath: "/tmp/unused",
    logLevel: "silent",
    logFormat: "json",
    gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
    napcat: { enabled: false, adapterId: "qq", reconnectMs: 3000 },
  };
  const app = await createHttpApplication({
    config,
    adapterHost: {
      status: () => ({
        ...host.status(),
        connectionUrl: "ws://hidden",
        adapters: host
          .status()
          .adapters.map((snapshot) => ({
            ...snapshot,
            accessToken: "private-secret",
          })),
      }),
    },
    webGateway: host.webGateway,
  });
  cleanup.push(() => app.close());
  expect((await app.inject("/api/v1/adapters/status")).statusCode).toBe(401);
  const response = await app.inject({
    url: "/api/v1/adapters/status",
    headers: { authorization: "Bearer management-token" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toEqual(host.status());
  expect(response.body).not.toMatch(
    /postgresql|management-token|wsUrl|accessToken|private-secret|ws:\/\/hidden/,
  );
  for (let index = 0; index < 35; index++) {
    expect(
      (
        await app.inject({
          url: "/api/v1/adapters/status",
          headers: { authorization: "Bearer management-token" },
        })
      ).statusCode,
    ).toBe(200);
  }
  const unavailable = await app.inject({
    method: "POST",
    url: "/api/v1/messages",
    headers: { authorization: "Bearer management-token" },
    payload: { text: "hello" },
  });
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json().error.code).toBe("runtime_unavailable");
  expect((await app.inject("/healthz")).statusCode).toBe(200);
  await host.stop();
});

it("registers only usable outbound transports without coupling adapter start to Runtime", async () => {
  const { host } = fixture();
  const outboundTransport = {
    sendMessage: vi.fn(
      async (
        target: import("@kaguya/platform-adapters").PlatformMessageTarget,
      ) => ({ ok: true, adapterId: "qq", platform: "qq" as const, target }),
    ),
  };
  const start = vi.fn(async () => {});
  host.register(adapter("qq", { outboundTransport, start }));
  host.register(adapter("disabled", { outboundTransport, enabled: false }));
  host.register(
    adapter("invalid", {
      outboundTransport,
      configurationError: "configuration_invalid",
    }),
  );
  const registerTransport = vi.fn();
  host.registerTransports({
    registerTransport,
    submit: async () => ({ rootInformationId: "root", deliveries: [] }),
  });
  expect(start).not.toHaveBeenCalled();
  expect(registerTransport).toHaveBeenCalledExactlyOnceWith({
    adapterId: "qq",
    platform: "qq",
    transport: outboundTransport,
  });
  await host.start();
  expect(start).toHaveBeenCalledOnce();
  await host.stop();
});
it("reports safe asynchronous submission failure once after accepted", async () => {
  const { host, logs } = fixture();
  host.register(adapter("qq"));
  host.finalizeRuntime({
    submit: async () => {
      throw new Error("ws://secret?token=credential");
    },
  });
  host.acceptInbound(message);
  await expect(host.ingress.submit(message)).rejects.toThrow(
    "Adapter submission failed",
  );
  expect(logs.map((log) => log.event)).toEqual([
    "napcat.inbound.received",
    "napcat.inbound.accepted",
    "napcat.inbound.failed",
  ]);
  expect(logs.at(-1)?.errorType).toBe("submission_failed");
  expect(JSON.stringify(logs)).not.toMatch(/ws:\/\/secret|credential/);
});
