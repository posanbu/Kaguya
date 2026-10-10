/** 使用真实 PGlite、ModuleHost 与 Runtime 验证插件的授权输出、持久链和恢复。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestingDatabase } from "../../../packages/database/src/testing.ts";
import {
  createMessageCatalog,
  createMessageComposition,
} from "../../../packages/composition/src/index.ts";
import { createFirstPartyModuleConfigDefaults } from "../../../packages/modules/src/index.ts";
import { defineInformationModuleCatalog } from "@kaguya/sdk";
import {
  FileMediaResourceStore,
  GatewayAllowlist,
  KaguyaRuntime,
} from "../../../packages/runtime/dist/index.js";
import createPlugin from "./index.mjs";

import { wav } from "./audio-fixture.mjs";
const now = new Date("2026-10-10T04:00:01.000Z");
const resources = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const resource of resources.splice(0)) {
    await resource.runtime?.close();
    await resource.database.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});

async function fixture(mode = "voice-fallback-text") {
  const root = await mkdtemp(join(tmpdir(), "kaguya-tts-runtime-"));
  const database = await createTestingDatabase();
  const resource = { root, database };
  resources.push(resource);
  const base = createMessageCatalog();
  const kinds = new Map(
    base.definitions
      .flatMap(({ manifest }) => [...manifest.consumes, ...manifest.produces])
      .map((kind) => [kind.kind, kind]),
  );
  const plugin = createPlugin({ kind: (name) => kinds.get(name) });
  const catalog = defineInformationModuleCatalog(
    ...base.definitions,
    ...plugin.catalog.definitions,
  );
  const moduleConfigs = [
    ...createFirstPartyModuleConfigDefaults("test"),
    {
      version: 1,
      instanceId: "tts.default",
      definitionId: "plugin.qwen-tts",
      enabled: true,
      settings: {
        mode,
        scopeAllowlist: ["qq:napcat:private:42"],
        apiKey: "never-persist-this-secret",
        endpoint: "https://workspace.example",
        voiceId: "test-voice",
      },
    },
  ];
  const sent = vi.fn(async (target) => ({
    ok: true,
    adapterId: "napcat",
    platform: "qq",
    target,
    platformMessageId: "sent-1",
  }));
  const build = () => {
    const composition = createMessageComposition(undefined, {
      catalog,
      moduleConfigs,
    });
    expect(
      composition.activations.some(
        (item) => item.definitionId === "agent.message-output.text",
      ),
    ).toBe(false);
    const runtime = new KaguyaRuntime({
      ...composition,
      database,
      now: () => now,
      mediaResources: new FileMediaResourceStore(root),
      outboundAllowlist: new GatewayAllowlist(["qq:private:42"]),
    });
    runtime.registerTransport({
      adapterId: "napcat",
      platform: "qq",
      transport: { sendMessage: sent },
    });
    resource.runtime = runtime;
    return runtime;
  };
  const runtime = build();
  await runtime.start();
  return { runtime, database, sent, build, moduleConfigs };
}

async function settled(database) {
  await vi.waitFor(
    async () => {
      const health = await database.information.reliable.health();
      expect(health.pending, JSON.stringify(health)).toBe(0);
    },
    { timeout: 8000, interval: 20 },
  );
}
async function waitForOutput(f) {
  try {
    await vi.waitFor(() => expect(f.sent).toHaveBeenCalledTimes(1), {
      timeout: 8000,
      interval: 20,
    });
  } catch (cause) {
    const atoms = await f.database.information.inspectPage({ limit: 200 });
    const queue = await f.database.sql.query(
      "SELECT subscription_id, state, attempts FROM information_deliveries WHERE state != 'acked'",
    );
    throw new Error(
      `No output: ${JSON.stringify({ atoms: atoms.map((atom) => ({ kind: atom.kind, ...(/failed|cancelled|exhausted/u.test(atom.kind) ? { payload: atom.payload } : {}) })), queue: queue.rows })}`,
      { cause },
    );
  }
}
function message() {
  return {
    platform: "qq",
    adapterId: "napcat",
    platformMessageId: "in-1",
    occurredAt: "2026-10-10T04:00:00.000Z",
    text: "你好",
    mentions: [],
    target: { kind: "private", userId: "42" },
    sender: { userId: "42", nickname: "测试人物" },
  };
}

describe("independent TTS Runtime composition", () => {
  it("persists the complete audio chain and reuses it after restart with changed settings", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: { audio: { url: "https://audio.example/a.wav" } },
            request_id: "tts-1",
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(wav));
    vi.stubGlobal("fetch", fetch);
    const f = await fixture();
    await f.runtime.submit(message());
    await waitForOutput(f);
    await settled(f.database);
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(f.sent.mock.calls[0][1]).toMatchObject({
      kind: "audio",
      text: "It is a lovely night for watching the moon.",
    });
    expect(new Uint8Array(f.sent.mock.calls[0][2].media.bytes)).toEqual(wav);
    const atoms = await f.database.information.inspectPage({ limit: 200 });
    for (const kind of [
      "core.message.assistant.text",
      "core.message.assistant.authorized",
      "agent.tts.requested.v1",
      "agent.tts.started.v1",
      "agent.tts.completed.v1",
      "core.delivery.requested",
      "core.delivery.delivered",
    ])
      expect(atoms.filter((item) => item.kind === kind)).toHaveLength(1);
    expect(JSON.stringify(atoms)).not.toContain("never-persist-this-secret");
    expect(JSON.stringify(atoms)).not.toContain("base64://");
    const assistant = atoms.find(
      (item) => item.kind === "core.message.assistant.text",
    );
    const completed = atoms.find(
      (item) => item.kind === "agent.tts.completed.v1",
    );
    const delivery = atoms.find(
      (item) => item.kind === "core.delivery.requested",
    );
    expect(delivery.references).toContainEqual({
      relation: "core:caused-by",
      informationId: assistant.informationId,
    });
    expect(delivery.references).toContainEqual({
      relation: "core:result",
      informationId: completed.informationId,
    });
    expect(delivery.payload.turn).not.toBeNull();
    expect(
      atoms.find((item) => item.kind === "agent.tts.requested.v1").references,
    ).toContainEqual({
      relation: "agent:turn-claim",
      informationId: delivery.payload.turn.claimInformationId,
    });
    await f.runtime.close();
    // 模拟成功处理后持久订阅的确认丢失。业务事实不修改，恢复必须复用既有产物和投递。
    await f.database.sql.query(
      "UPDATE information_deliveries SET state = 'pending', available_at = NOW() WHERE information_id = $1",
      [
        atoms.find((item) => item.kind === "core.message.assistant.authorized")
          .informationId,
      ],
    );
    f.moduleConfigs.at(-1).settings.mode = "text";
    const restarted = f.build();
    await restarted.start();
    await settled(f.database);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(
      await f.database.information.inspectPage({
        kinds: ["core.delivery.requested"],
        limit: 20,
      }),
    ).toHaveLength(1);
  });

  it("records a permanent provider failure and sends exactly one text fallback", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("secret provider body", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const f = await fixture();
    await f.runtime.submit(message());
    await waitForOutput(f);
    await settled(f.database);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(f.sent.mock.calls[0][1].kind).toBe("text");
    const atoms = await f.database.information.inspectPage({ limit: 200 });
    expect(
      atoms.find((item) => item.kind === "agent.tts.failed.v1").payload,
    ).toMatchObject({ code: "unauthorized", fallback: "text" });
    expect(atoms.some((item) => item.kind === "agent.tts.completed.v1")).toBe(
      false,
    );
    expect(JSON.stringify(atoms)).not.toContain("secret provider body");
  });

  it("aborts an unfinished provider call on shutdown and rejects its late result", async () => {
    const response = Promise.withResolvers();
    const started = Promise.withResolvers();
    const fetch = vi.fn(() => {
      started.resolve();
      return response.promise;
    });
    vi.stubGlobal("fetch", fetch);
    const f = await fixture();
    await f.runtime.submit(message());
    await started.promise;
    await f.runtime.close();
    response.resolve(
      new Response(
        JSON.stringify({
          output: { audio: { url: "https://audio.example/a.wav" } },
        }),
      ),
    );
    await response.promise;
    const atoms = await f.database.information.inspectPage({ limit: 200 });
    expect(atoms.some((atom) => atom.kind === "agent.tts.started.v1")).toBe(
      true,
    );
    expect(
      atoms.some(
        (atom) =>
          atom.kind === "agent.tts.completed.v1" ||
          atom.kind === "core.delivery.requested",
      ),
    ).toBe(false);
    expect(f.sent).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous platform failure terminal without a second text side effect", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              output: { audio: { url: "https://audio.example/a.wav" } },
            }),
          ),
        )
        .mockResolvedValueOnce(new Response(wav)),
    );
    const f = await fixture();
    f.sent.mockImplementation(async (target) => ({
      ok: false,
      adapterId: "napcat",
      platform: "qq",
      target,
      error: "platform timeout",
    }));
    await f.runtime.submit(message());
    await waitForOutput(f);
    await settled(f.database);
    const atoms = await f.database.information.inspectPage({ limit: 200 });
    expect(
      atoms.filter((atom) => atom.kind === "core.delivery.requested"),
    ).toHaveLength(1);
    expect(
      atoms.filter((atom) => atom.kind === "core.delivery.failed"),
    ).toHaveLength(1);
    expect(atoms.some((atom) => atom.kind === "core.delivery.delivered")).toBe(
      false,
    );
    expect(f.sent).toHaveBeenCalledTimes(1);
  });

  it("keeps text mode free of synthesis calls", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const f = await fixture("text");
    await f.runtime.submit(message());
    await waitForOutput(f);
    await settled(f.database);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(f.sent.mock.calls[0][1].kind).toBe("text");
    expect(
      await f.database.information.inspectPage({
        kinds: ["agent.tts.requested.v1"],
        limit: 20,
      }),
    ).toHaveLength(0);
  });
});
