import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileUserConfigManager } from "@kaguya/config";
import { runTtsCommand } from "./tts-cli.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it("uses selected Profile credentials for explicit voice management while online TTS is off", async () => {
  const root = await mkdtemp(join(tmpdir(), "tts-cli-"));
  roots.push(root);
  const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
  const profile = await manager.getProfile("default");
  await manager.replaceProfile("default", {
    name: "default",
    acknowledgedWarnings: [],
    identity: profile.identity,
    ai: {
      providers: [
        {
          id: "qwen",
          type: "openai-compatible",
          enabled: false,
          apiKey: "test-private",
          models: [],
          settings: {
            tts: {
              enabled: false,
              region: "singapore",
              model: "qwen3-tts-vc-2026-01-22",
              accountScope: "test",
              voice: "placeholder",
              audioHosts: ["test.oss-ap-southeast-1.aliyuncs.com"],
            },
          },
        },
      ],
    },
  });
  vi.stubEnv("KAGUYA_CONFIG_ROOT", root);
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ output: { voice_list: [] } }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await runTtsCommand(["list", "qwen", "0"])).toEqual([]);
  expect(fetcher.mock.calls[0]![0]).toBe(
    "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization",
  );
  expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({
    Authorization: "Bearer test-private",
  });
  const reference = join(root, "reference.wav");
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF");
  bytes.write("WAVE", 8);
  await writeFile(reference, bytes);
  fetcher.mockResolvedValueOnce(
    Response.json({ output: { voice: "new-voice" } }),
  );
  expect(
    await runTtsCommand(["create", "qwen", "myvoice", reference]),
  ).toMatchObject({ voice: "new-voice", region: "singapore" });
  expect(
    (await manager.getProfile("default")).ai.providers[0]!.settings.tts,
  ).toMatchObject({ voice: "placeholder", enabled: false });
  // Existing output must fail before sending a paid synthesis request.
  await expect(
    runTtsCommand(["sample", "qwen", "你好", reference]),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
