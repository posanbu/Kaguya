import { describe, expect, it, vi } from "vitest";
import { QwenTtsProvider } from "./provider.mjs";

import { wav } from "./audio-fixture.mjs";

describe("QwenTtsProvider", () => {
  it("keeps credentials in HTTP headers and validates downloaded WAV bytes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: { audio: { url: "https://audio.example/result.wav" } },
            request_id: "req-1",
            usage: { input_tokens: 2, output_tokens: 8, total_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(wav, {
          status: 200,
          headers: {
            "content-type": "audio/wav",
            "content-length": String(wav.byteLength),
          },
        }),
      );
    const provider = new QwenTtsProvider({
      apiKey: "secret",
      endpoint: "https://workspace.example",
      fetch,
    });
    await expect(
      provider.synthesize({
        text: "你好",
        model: "qwen3-tts-vc-2026-01-22",
        voiceId: "yachiyo",
        language: "Chinese",
        format: "wav",
      }),
    ).resolves.toMatchObject({
      mimeType: "audio/wav",
      requestId: "req-1",
      usage: { inputTokens: 2, outputTokens: 8, totalTokens: 10 },
    });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://workspace.example/api/v1/services/aigc/multimodal-generation/generation",
    );
    const init = fetch.mock.calls[0][1];
    expect(init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toMatchObject({
      input: { text: "你好", voice: "yachiyo", language_type: "Chinese" },
    });
  });

  it("rejects an invalid audio body", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: { audio: { url: "https://audio.example/result.wav" } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      );
    const provider = new QwenTtsProvider({
      apiKey: "secret",
      endpoint: "https://workspace.example",
      fetch,
    });
    await expect(
      provider.synthesize({
        text: "你好",
        model: "model",
        voiceId: "voice",
        language: "Chinese",
        format: "wav",
      }),
    ).rejects.toMatchObject({ code: "invalid-audio" });
  });

  it("rejects a RIFF header with truncated chunks instead of accepting its magic bytes", async () => {
    const broken = wav.slice();
    new DataView(broken.buffer).setUint32(40, 4096, true);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: { audio: { url: "https://audio.example/a.wav" } },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(broken));
    const provider = new QwenTtsProvider({
      apiKey: "secret",
      endpoint: "https://workspace.example",
      fetch,
    });
    await expect(
      provider.synthesize({
        text: "你好",
        model: "model",
        voiceId: "voice",
        language: "Chinese",
      }),
    ).rejects.toMatchObject({ code: "invalid-audio" });
  });

  it("creates and deletes voices with the same account and region as synthesis", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ output: { voice: "created-voice" } })),
      );
    const provider = new QwenTtsProvider({
      apiKey: "secret",
      endpoint: "https://workspace.example",
      fetch,
    });
    await provider.createVoice({
      model: "qwen-voice-enrollment",
      targetModel: "target-model",
      name: "yachiyo",
      audioDataUrl: "https://reference.example/a.wav",
    });
    await provider.deleteVoice({
      model: "qwen-voice-enrollment",
      voiceId: "created-voice",
    });
    for (const call of fetch.mock.calls) {
      expect(call[0]).toBe(
        "https://workspace.example/api/v1/services/audio/tts/customization",
      );
      expect(call[1].headers.authorization).toBe("Bearer secret");
    }
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      model: "qwen-voice-enrollment",
      input: {
        action: "create",
        target_model: "target-model",
        preferred_name: "yachiyo",
        audio: { data: "https://reference.example/a.wav" },
      },
    });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({
      input: { action: "delete", voice: "created-voice" },
    });
  });

  it("lists voices in the configured region before selecting one", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            voice_list: [
              { voice: "other", target_model: "model" },
              { voice: "yachiyo", target_model: "target" },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const provider = new QwenTtsProvider({
      apiKey: "secret",
      endpoint: "https://dashscope-intl.aliyuncs.com",
      fetch,
    });
    await expect(
      provider.queryVoice({
        model: "qwen-voice-enrollment",
        targetModel: "target",
        voiceId: "yachiyo",
      }),
    ).resolves.toMatchObject({
      voice: { voice: "yachiyo", target_model: "target" },
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      model: "qwen-voice-enrollment",
      input: { action: "list", page_index: 0, page_size: 100 },
    });
  });

  it("bounds streaming bodies even without content-length", async () => {
    let cancelled = false;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: { audio: { url: "https://audio.example/a.wav" } },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(32));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    const provider = new QwenTtsProvider({
      apiKey: "secret",
      endpoint: "https://workspace.example",
      fetch,
      maxAudioBytes: 16,
    });
    await expect(
      provider.synthesize({
        text: "你好",
        model: "model",
        voiceId: "voice",
        language: "Chinese",
      }),
    ).rejects.toMatchObject({ code: "audio-too-large" });
    expect(cancelled).toBe(true);
  });

  it("times out while reading a stalled response body", async () => {
    let cancelled = false;
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    const provider = new QwenTtsProvider({
      apiKey: "secret",
      endpoint: "https://workspace.example",
      fetch,
      timeoutMs: 20,
    });
    await expect(
      provider.synthesize({
        text: "你好",
        model: "model",
        voiceId: "voice",
        language: "Chinese",
      }),
    ).rejects.toMatchObject({ code: "timeout-or-cancelled" });
    expect(cancelled).toBe(true);
  });

  it("does not call the provider when already cancelled", async () => {
    const fetch = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const provider = new QwenTtsProvider({
      apiKey: "secret",
      endpoint: "https://workspace.example",
      fetch,
    });
    await expect(
      provider.synthesize(
        { text: "你好", model: "model", voiceId: "voice", language: "Chinese" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "timeout-or-cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies permanent credential failures without exposing response bodies", async () => {
    const provider = new QwenTtsProvider({
      apiKey: "secret",
      endpoint: "https://workspace.example",
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response("private provider details", { status: 401 }),
        ),
    });
    await expect(
      provider.synthesize({
        text: "你好",
        model: "model",
        voiceId: "voice",
        language: "Chinese",
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
      message: "Qwen request failed (401)",
    });
  });
});
