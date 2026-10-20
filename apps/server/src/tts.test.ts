import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileUserConfigManager } from "@kaguya/config";
import { ttsTaskKey } from "@kaguya/llm";
import type { RuntimeCapabilityContext } from "@kaguya/runtime";
import { assistantTextInformationKind } from "@kaguya/modules";
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";
import { createServerTts, serverTtsSettingsSchema } from "./tts.js";
import type { NapCatConfig } from "./config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const settings = {
  enabled: true,
  region: "beijing",
  accountScope: "test-account",
  model: "qwen3-tts-vc-2026-01-22",
  voice: "test-voice",
  language: "Chinese",
  audioHosts: ["test.oss-cn-beijing.aliyuncs.com"],
  conversations: ["qq:group:123"],
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tts-host-"));
  roots.push(root);
  const manager = await FileUserConfigManager.bootstrap({
    rootDir: join(root, "config"),
  });
  const profile = await manager.getProfile("default");
  profile.ai.providers.push({
    id: "tts",
    type: "openai-compatible",
    enabled: true,
    apiKey: "secret-test-key",
    models: [],
    settings: { tts: settings },
  });
  profile.runtime = {
    host: "127.0.0.1",
    port: 3000,
    databaseMode: "external",
    databaseUrl: "postgresql://test@localhost/db",
    webDistPath: "web",
    corsOrigins: [],
    trustProxy: false,
    rateLimitMax: 1000,
    rateLimitWindowMs: 60000,
    logLevel: "silent",
    logFormat: "json",
    inboundAllowlist: [],
    outboundAllowlist: ["qq:group:*"],
  };
  const napcat = {
    enabled: true,
    adapterId: "napcat.qq.main",
    reconnectMs: 1000,
    capture: {},
  } as unknown as NapCatConfig;
  return { root, profile, napcat };
}
it("is inert when disabled and rejects ambiguous providers or wildcard conversations", async () => {
  const f = await setup();
  f.profile.ai.providers[0]!.settings = { tts: { enabled: false } };
  expect(createServerTts(f.profile, f.root, f.napcat)).toBeUndefined();
  expect(
    serverTtsSettingsSchema.safeParse({
      ...settings,
      conversations: ["qq:group:*"],
    }).success,
  ).toBe(false);
  f.profile.ai.providers[0]!.settings = { tts: settings };
  f.profile.ai.providers.push({ ...f.profile.ai.providers[0]!, id: "other" });
  expect(() => createServerTts(f.profile, f.root, f.napcat)).toThrow(
    "Only one",
  );
});
it("restricts target, frozen identity, source text, expiry and terminal turn before synthesis", async () => {
  const f = await setup();
  const service = createServerTts(f.profile, f.root, f.napcat)!;
  const target = {
    adapterId: f.napcat.adapterId,
    platform: "qq",
    destination: { kind: "group", groupId: "123" },
  };
  const turn = {
    candidateInformationId: "candidate",
    claimInformationId: "claim",
    contextInformationId: "context",
  };
  const assistant = {
    informationId: "assistant",
    kind: assistantTextInformationKind.kind,
    payload: {
      text: "你好",
      source: target,
      turn,
      originatingModuleInstanceId: "heavy.default",
    },
  } as unknown as DeepReadonly<InformationAtom>;
  const get = vi.fn(async () => assistant);
  const select = vi.fn(
    async (): Promise<readonly DeepReadonly<InformationAtom>[]> => [],
  );
  const context = {
    core: { get, select },
    now: () => new Date("2026-10-19T00:00:00Z"),
  } as unknown as RuntimeCapabilityContext;
  const host = service.host(context);
  const plan = await host.plan(assistant);
  expect(plan).toBeDefined();
  expect(JSON.stringify(plan)).not.toContain("secret-test-key");
  const request = {
    assistantInformationId: "assistant",
    text: "你好",
    target: target as {
      adapterId: string;
      platform: string;
      destination: { kind: "group"; groupId: string };
    },
    turn,
    identity: plan!.identity,
    expiresAt: plan!.expiresAt,
    taskKey: ttsTaskKey("assistant", "你好", plan!.identity),
  };
  expect(await host.isCurrent(request)).toBe(true);
  expect(await host.isCurrent({ ...request, text: "改写" })).toBe(false);
  expect(
    await host.isCurrent({ ...request, expiresAt: "2020-01-01T00:00:00Z" }),
  ).toBe(false);
  expect(
    await host.isCurrent({
      ...request,
      target: {
        ...request.target,
        destination: { kind: "group", groupId: "456" },
      },
    }),
  ).toBe(false);
  select.mockResolvedValue([assistant]);
  expect(await host.isCurrent(request)).toBe(false);
  const changed = structuredClone(f.profile);
  changed.ai.providers[0]!.settings = {
    tts: { ...settings, accountScope: "different-account" },
  };
  expect(
    await createServerTts(changed, f.root, f.napcat)!
      .host(context)
      .isCurrent(request),
  ).toBe(false);
});
