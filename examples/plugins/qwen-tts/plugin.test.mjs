import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizedAssistantOutputInformationKind,
  deliveryRequestedInformationKind,
  turnCompletedInformationKind,
  turnFailedInformationKind,
  turnSilentInformationKind,
  turnSupersededInformationKind,
  turnWaitingInformationKind,
} from "../../../packages/modules/src/index.ts";
import { turnInterruptedInformationKind } from "../../../packages/modules/src/first-party/information-kinds.ts";
import createPlugin, {
  ttsRequested,
  ttsCompleted,
  ttsCancelled,
} from "./index.mjs";
import * as publicKinds from "../../../packages/modules/src/index.ts";
import { wav } from "./audio-fixture.mjs";
const turnKinds = [
  turnCompletedInformationKind,
  turnFailedInformationKind,
  turnSilentInformationKind,
  turnSupersededInformationKind,
  turnWaitingInformationKind,
  turnInterruptedInformationKind,
];

describe("Qwen TTS plugin declaration", () => {
  it("is independently declared and defaults to text mode", () => {
    const kinds = new Map([
      ...turnKinds.map((kind) => [kind.kind, kind]),
      [
        authorizedAssistantOutputInformationKind.kind,
        authorizedAssistantOutputInformationKind,
      ],
      [deliveryRequestedInformationKind.kind, deliveryRequestedInformationKind],
    ]);
    const plugin = createPlugin({
      kind(name) {
        const kind = kinds.get(name);
        if (!kind) throw new Error(name);
        return kind;
      },
    });
    expect(plugin.id).toBe("kaguya.qwen-tts");
    const definition = plugin.catalog.definitions[0];
    expect(definition.manifest.definitionId).toBe("plugin.qwen-tts");
    expect(definition.manifest.settingsSchema.parse({})).toMatchObject({
      mode: "text",
      scopeAllowlist: [],
    });
    expect(definition.manifest.requires.map((item) => item.id)).toEqual([
      "kaguya:media-resource-store",
    ]);
    expect(definition.manifest.provides.map((item) => item.id)).toEqual([
      "agent:message-output-processor",
    ]);
  });

  it("records request, completed resource and one audio delivery", async () => {
    const kinds = new Map([
      ...turnKinds.map((kind) => [kind.kind, kind]),
      [
        authorizedAssistantOutputInformationKind.kind,
        authorizedAssistantOutputInformationKind,
      ],
      [deliveryRequestedInformationKind.kind, deliveryRequestedInformationKind],
    ]);
    const definition = createPlugin({ kind: (name) => kinds.get(name) }).catalog
      .definitions[0];
    const settings = definition.manifest.settingsSchema.parse({
      mode: "voice-fallback-text",
      scopeAllowlist: ["qq:napcat:private:42"],
      apiKey: "secret",
      endpoint: "https://workspace.example",
      voiceId: "yachiyo",
    });
    const instance = definition.create({
      instanceId: "tts",
      settings,
      activation: { instanceId: "tts", definitionId: "plugin.qwen-tts" },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              output: { audio: { url: "https://audio.example/result.wav" } },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(wav, { status: 200 })),
    );
    const stored = [];
    const calls = [];
    const requested = {
      informationId: "request-1",
      kind: "agent.tts.requested.v1",
      payload: {},
    };
    const completed = {
      informationId: "completed-1",
      kind: "agent.tts.completed.v1",
      payload: {},
    };
    const context = {
      signal: new AbortController().signal,
      select: vi.fn().mockResolvedValue([]),
      use: () => ({ put: async (value) => stored.push(value) }),
      registerOnce: vi.fn(async (operation, key, kind, input) => {
        calls.push({ operation, key, kind: kind.kind, input });
        return kind.kind === "agent.tts.requested.v1"
          ? { ...requested, payload: input.payload }
          : {
              informationId: "delivery-1",
              kind: kind.kind,
              payload: input.payload,
            };
      }),
      commitTerminal: vi.fn(async (_group, _subject, kind, input) => {
        Object.assign(completed, { kind: kind.kind, payload: input.payload });
        return completed;
      }),
    };
    await instance.subscriptions[0].handle(
      {
        informationId: "authorized-1",
        kind: authorizedAssistantOutputInformationKind.kind,
        payload: {
          text: "你好",
          source: {
            platform: "qq",
            adapterId: "napcat",
            destination: { kind: "private", userId: "42" },
          },
          originatingModuleInstanceId: "heavy",
          turn: null,
        },
        references: [
          { relation: "core:caused-by", informationId: "assistant-1" },
        ],
      },
      context,
    );
    expect(stored).toHaveLength(1);
    expect(context.commitTerminal).toHaveBeenCalledWith(
      "agent.tts.result.v1",
      "request-1",
      expect.objectContaining({ kind: "agent.tts.completed.v1" }),
      expect.anything(),
    );
    expect(calls.map((call) => call.kind)).toEqual([
      "agent.tts.requested.v1",
      "agent.tts.started.v1",
      "core.delivery.requested",
    ]);
    expect(calls[2].input.payload.message).toMatchObject({
      kind: "audio",
      text: "你好",
      resourceId: expect.stringMatching(/^sha256:/u),
    });
  });

  it("falls back once when a replayed completed resource is missing", async () => {
    const kinds = new Map([
      ...turnKinds.map((kind) => [kind.kind, kind]),
      [
        authorizedAssistantOutputInformationKind.kind,
        authorizedAssistantOutputInformationKind,
      ],
      [deliveryRequestedInformationKind.kind, deliveryRequestedInformationKind],
    ]);
    const definition = createPlugin({ kind: (name) => kinds.get(name) }).catalog
      .definitions[0];
    const instance = definition.create({
      instanceId: "tts",
      settings: definition.manifest.settingsSchema.parse({
        mode: "voice-fallback-text",
        scopeAllowlist: ["qq:napcat:private:42"],
        apiKey: "secret",
        voiceId: "yachiyo",
      }),
      activation: { instanceId: "tts", definitionId: "plugin.qwen-tts" },
    });
    const requested = {
      informationId: "request-1",
      kind: "agent.tts.requested.v1",
      payload: {},
    };
    const completed = {
      informationId: "completed-1",
      kind: "agent.tts.completed.v1",
      payload: {
        resourceId: `sha256:${"a".repeat(64)}`,
        sha256: "a".repeat(64),
        byteLength: 12,
        mimeType: "audio/wav",
        text: "你好",
        elapsedMs: 1,
      },
    };
    const calls = [];
    const context = {
      signal: new AbortController().signal,
      select: vi.fn().mockResolvedValue([requested, completed]),
      use: () => ({ get: vi.fn().mockResolvedValue(undefined) }),
      registerOnce: vi.fn(async (operation, key, kind, input) => {
        calls.push({ operation, key, kind: kind.kind, input });
        return kind.kind === "agent.tts.requested.v1"
          ? requested
          : {
              informationId: "delivery-1",
              kind: kind.kind,
              payload: input.payload,
            };
      }),
    };
    await instance.subscriptions[0].handle(
      {
        informationId: "authorized-1",
        kind: authorizedAssistantOutputInformationKind.kind,
        payload: {
          text: "你好",
          source: {
            platform: "qq",
            adapterId: "napcat",
            destination: { kind: "private", userId: "42" },
          },
          originatingModuleInstanceId: "heavy",
          turn: null,
        },
        references: [
          { relation: "core:caused-by", informationId: "assistant-1" },
        ],
      },
      context,
    );
    expect(calls.map(({ operation }) => operation)).toEqual([
      "qwen-tts.fallback.v1",
      "qwen-tts.delivery.v1",
    ]);
    expect(calls[0].input.payload.reason).toBe("resource-missing");
    expect(calls[1].input.payload.message).toEqual({
      kind: "text",
      text: "你好",
    });
    expect(calls[1].input.references).toContainEqual({
      relation: "core:result",
      informationId: "delivery-1",
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

function outputFixture(settingsOverrides = {}) {
  const registry = new Map(
    Object.values(publicKinds)
      .filter(
        (item) => item && typeof item.kind === "string" && item.payloadSchema,
      )
      .map((kind) => [kind.kind, kind]),
  );
  registry.set(
    turnInterruptedInformationKind.kind,
    turnInterruptedInformationKind,
  );
  const definition = createPlugin({ kind: (name) => registry.get(name) })
    .catalog.definitions[0];
  const settings = definition.manifest.settingsSchema.parse({
    mode: "voice-fallback-text",
    scopeAllowlist: ["qq:napcat:private:42"],
    apiKey: "secret",
    endpoint: "https://workspace.example",
    voiceId: "voice",
    ...settingsOverrides,
  });
  const instance = definition.create({
    instanceId: "tts",
    settings,
    activation: { instanceId: "tts", definitionId: "plugin.qwen-tts" },
  });
  const source = {
    informationId: "authorized",
    kind: authorizedAssistantOutputInformationKind.kind,
    payload: {
      text: "你好",
      source: {
        platform: "qq",
        adapterId: "napcat",
        destination: { kind: "private", userId: "42" },
      },
      originatingModuleInstanceId: "heavy",
      turn: null,
    },
    references: [{ relation: "core:caused-by", informationId: "assistant" }],
  };
  const atoms = [];
  const slots = new Map();
  const controller = new AbortController();
  const store = { put: vi.fn(), get: vi.fn() };
  const context = {
    signal: controller.signal,
    select: vi.fn(async () => atoms),
    use: () => store,
    registerOnce: vi.fn(async (operation, key, kind, input) => {
      controller.signal.throwIfAborted();
      const slot = `${operation}:${key}`;
      if (!slots.has(slot)) {
        const atom = {
          informationId: `fact-${atoms.length + 1}`,
          kind: kind.kind,
          payload: kind.payloadSchema.parse(input.payload),
          references: input.references ?? [],
        };
        slots.set(slot, atom);
        atoms.push(atom);
      }
      return slots.get(slot);
    }),
    commitTerminal: vi.fn(async (group, subject, kind, input) =>
      context.registerOnce(group, subject, kind, input),
    ),
  };
  return {
    source,
    atoms,
    context,
    store,
    settings,
    controller,
    run: () => instance.subscriptions[0].handle(source, context),
  };
}

describe("TTS output recovery boundaries", () => {
  it("reuses completed bytes before first delivery even when current mode changes to text", async () => {
    const f = outputFixture({ mode: "text" });
    const request = await f.context.registerOnce(
      "qwen-tts.requested.v1",
      f.source.informationId,
      ttsRequested,
      {
        payload: {
          text: "你好",
          model: f.settings.model,
          voiceId: "frozen-voice",
          language: "Chinese",
          format: "wav",
          endpoint: f.settings.endpoint,
          timeoutMs: 30000,
          maxAudioBytes: 1024,
          destination: f.source.payload.source.destination,
        },
      },
    );
    const sha256 = "a".repeat(64);
    await f.context.commitTerminal(
      "agent.tts.result.v1",
      request.informationId,
      ttsCompleted,
      {
        payload: {
          resourceId: `sha256:${sha256}`,
          sha256,
          mimeType: "audio/wav",
          byteLength: 12,
          text: "你好",
          elapsedMs: 1,
        },
      },
    );
    f.store.get.mockResolvedValue({
      resourceId: `sha256:${sha256}`,
      bytes: new Uint8Array(12),
      mimeType: "audio/wav",
      sha256,
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await f.run();
    await f.run();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.store.put).not.toHaveBeenCalled();
    expect(
      f.atoms.filter((atom) => atom.kind === "core.delivery.requested"),
    ).toHaveLength(1);
    expect(f.atoms.at(-1).payload.message.kind).toBe("audio");
  });

  it("cancels audio when its turn ends during synthesis", async () => {
    const f = outputFixture();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(async () => {
          f.atoms.push({
            informationId: "closed",
            kind: "agent.router.turn.failed",
          });
          return new Response(
            JSON.stringify({
              output: { audio: { url: "https://audio.example/a.wav" } },
            }),
          );
        })
        .mockResolvedValueOnce(new Response(wav)),
    );
    await f.run();
    expect(
      f.atoms.find((atom) => atom.kind === ttsCancelled.kind).payload.reason,
    ).toBe("turn-no-longer-active");
    expect(f.store.put).not.toHaveBeenCalled();
    expect(
      f.atoms.some((atom) => atom.kind === "core.delivery.requested"),
    ).toBe(false);
  });

  it.each(["web", "not-allowlisted", "code", "long"])(
    "uses text for %s without provider calls",
    async (branch) => {
      const f = outputFixture();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      if (branch === "web") {
        f.source.payload.source.platform = "web";
        f.source.payload.source.destination = { kind: "web" };
      }
      if (branch === "not-allowlisted")
        f.source.payload.source.destination.userId = "other";
      if (branch === "code") f.source.payload.text = "```js\nconst n = 1;\n```";
      if (branch === "long") f.source.payload.text = "字".repeat(501);
      await f.run();
      expect(fetch).not.toHaveBeenCalled();
      expect(f.atoms.map((atom) => atom.kind)).toEqual([
        "core.delivery.requested",
      ]);
      expect(f.atoms[0].payload.message.text).toBe(f.source.payload.text);
    },
  );
});
