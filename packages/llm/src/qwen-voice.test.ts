import { expect, it, vi } from "vitest";
import { createQwenVoiceManager } from "./qwen-voice.js";

const identity = {
  region: "beijing" as const,
  model: "qwen3-tts-vc-2026-01-22",
};
it("uses the synthesis region and model for explicit creation, without leaking reference data", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ output: { voice: "my-voice" } }),
  );
  const client = createQwenVoiceManager({
    identity,
    apiKey: "test-secret",
    fetch: fetcher,
  });
  const wav = Buffer.alloc(44);
  wav.write("RIFF");
  wav.write("WAVE", 8);
  expect(await client.create("yachiyo", wav)).toBe("my-voice");
  expect(fetcher.mock.calls[0]![0]).toBe(
    "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization",
  );
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
    model: "qwen-voice-enrollment",
    input: {
      action: "create",
      target_model: identity.model,
      preferred_name: "yachiyo",
    },
  });
  await expect(client.create("invalid name", wav)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("projects voice metadata only and does not retry or expose provider errors", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      output: {
        voice_list: [
          {
            voice: "voice",
            target_model: identity.model,
            resource_link: "signed-secret-url",
          },
        ],
      },
    }),
  );
  const client = createQwenVoiceManager({
    identity,
    apiKey: "test-secret",
    fetch: fetcher,
  });
  expect(await client.list(2)).toEqual([
    { voice: "voice", targetModel: identity.model },
  ]);
  fetcher.mockResolvedValueOnce(new Response("private error", { status: 403 }));
  await expect(client.list()).rejects.toMatchObject({
    code: "provider_rejected",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
